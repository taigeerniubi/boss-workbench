/**
 * 抓岗位的**可复用内核**。CLI（boss/scrape.mjs）和宿主路由（/boss/scrape）共用这一份。
 *
 * 拆出来的原因：UI 上点「抓取」和终端里敲命令必须是同一条代码路径。
 * 之前只有 CLI，工作台只能干看着 data/jobs.json，这就是"输入了没反应"的根。
 *
 * 三条硬约束原样保留（账号比数据重要）：
 *   1. code 35（IP 异常）立刻停，不重试、不换姿势硬撞；
 *   2. 页间随机延时，页数默认 3、上限 10；
 *   3. 只有显式 confirm 才真联网。
 */
import { join } from "node:path";
import {
	DATA_DIR, EXPERIENCE_MAP, JOB_TYPE_MAP, RUNS_DIR, SALARY_MAP, ensureDirs, filterJobs, httpApi,
	isFlagged, isLoggedOut, loadProfile, loadSession, markCooldown, normalizeJob, readCooldown, readJson,
	resolveCity, writeJson,
} from "./lib.mjs";

export const MAX_PAGES = 10;
export const RECOMMEND_PATH = "/wapi/zpgeek/pc/recommend/job/list.json";
export const SEARCH_PATH = "/wapi/zpgeek/search/joblist.json";

/**
 * 跑一轮抓取。
 *
 * @param {object} opts
 * @param {"search"|"recommend"} [opts.mode]  关键词搜索 / 推荐流
 * @param {string}  [opts.city]               城市名（默认 profile.homeCity）
 * @param {string}  [opts.query]              关键词（search 模式）
 * @param {number}  [opts.pages]              页数
 * @param {number}  [opts.pageSize]           每页条数
 * @param {number}  [opts.maxKm]              距离上限（只影响"抓回来之后给几条"，服务端没有这个参数）
 * @param {number}  [opts.minDelay]           页间最小延时
 * @param {number}  [opts.maxDelay]           页间最大延时
 * @param {boolean} [opts.save]               是否合并进 data/jobs.json（默认 true）
 * @param {(line: string) => void} [opts.log] 进度回调（CLI 打终端，UI 打进度条）
 * @returns {Promise<object>} 一份能被 UI 直接用的结果
 */
export async function runScrape(opts = {}) {
	const profile = loadProfile();
	const session = loadSession();
	const log = typeof opts.log === "function" ? opts.log : () => {};
	const mode = opts.mode === "recommend" ? "recommend" : "search";
	const city = opts.city ?? profile.homeCity;
	const query = opts.query ?? profile.keywords?.[0] ?? "";
	const pageSize = Math.min(Math.max(Number(opts.pageSize) || 30, 1), 30);
	const pages = Math.min(Math.max(Number(opts.pages) || 3, 1), MAX_PAGES);
	const minDelay = Number(opts.minDelay) || 3000;
	const maxDelay = Math.max(Number(opts.maxDelay) || 8000, minDelay);
	const maxKm = opts.maxKm ?? null;
	const save = opts.save !== false;

	if (session === null) return { ok: false, reason: "no-session", error: "还没有登录会话 —— 先在工作台里扫码登录（或跑 node boss/login.mjs）" };

	// ── 冷却期：撞过风控就别再打了 ──────────────────────────────────────────
	// 风控按行为频率扣分，而人在排障时最容易做的就是"再试一次"。
	// 所以把"停手"做成规则：见过 code 35/37 之后这里直接拒绝执行。
	const cold = readCooldown();
	if (cold !== null && cold.expired === false && opts.ignoreCooldown !== true) {
		const mins = Math.ceil(cold.remainingMs / 60000);
		return {
			ok: false,
			reason: "cooldown",
			error: `还在冷却期（约 ${mins} 分钟后解禁）。上一次撞到：${cold.message ?? cold.kind}。\n`
				+ `  风控是按频率扣分的，"再试一次"只会把分推得更高。\n`
				+ `  确实要现在跑：node boss/scrape.mjs … --ignore-cooldown，或者删掉 ${join(DATA_DIR, "cooldown.json")}`,
			cooldown: { kind: cold.kind, until: cold.until, remainingMs: cold.remainingMs, message: cold.message },
		};
	}

	const cityCode = resolveCity(city);
	if (mode === "search" && cityCode === null) {
		return { ok: false, reason: "no-city", error: `没有「${city}」的城市码。目前只内置了 北京 / 上海，其余城市要登录后缓存城市表。` };
	}
	if (mode === "search" && String(query).trim() === "") {
		return { ok: false, reason: "no-query", error: "搜索模式需要关键词。留空就走推荐流，或者填一个岗位关键词。" };
	}

	ensureDirs();
	const collected = [];
	const rawPages = [];
	let stopped = null;

	for (let p = 1; p <= pages; p++) {
		let path = SEARCH_PATH;
		let params;
		if (mode === "recommend") {
			path = RECOMMEND_PATH;
			params = { page: p, pageSize };
			if (opts.experience !== undefined && opts.experience !== null) params.experience = EXPERIENCE_MAP[opts.experience] ?? opts.experience;
			if (opts.jobType !== undefined && opts.jobType !== null) params.jobType = JOB_TYPE_MAP[opts.jobType] ?? opts.jobType;
			if (opts.salary !== undefined && opts.salary !== null) params.salary = SALARY_MAP[opts.salary] ?? opts.salary;
		} else {
			params = { scene: 1, query, city: cityCode, page: p, pageSize };
			if (opts.experience !== undefined && opts.experience !== null) params.experience = EXPERIENCE_MAP[opts.experience] ?? opts.experience;
		}

		let r;
		try {
			r = await httpApi(path, params, session, { referer: mode === "recommend" ? "https://www.zhipin.com/web/geek/job-recommend" : "https://www.zhipin.com/web/geek/jobs" });
		} catch (err) {
			stopped = { kind: "network", message: String(err?.message ?? err) };
			rawPages.push({ page: p, error: String(err?.message ?? err) });
			break;
		}

		if (isFlagged(r.json)) {
			stopped = { kind: "flagged", message: `风控 code 35：${r.json.message}` };
			markCooldown({ kind: "flagged", message: `code 35 风控：${r.json.message}` });
			rawPages.push({ page: p, url: r.url, flagged: true, body: r.json });
			break;
		}
		if (isLoggedOut(r.json)) {
			stopped = { kind: "logged-out", message: `登录态失效（code ${r.json.code}）` };
			rawPages.push({ page: p, url: r.url, body: r.json });
			break;
		}
		if (r.json?.code === 37) {
			stopped = { kind: "abnormal-env", message: `Boss 说"您的环境存在异常"（code 37）：${JSON.stringify(r.json?.zpData ?? {}).slice(0, 200)}` };
			// 37 是签名挑战，重试**不会**变好；而且连着重试同样会推高风险分。短锁一下。
			markCooldown({ kind: "abnormal-env", message: "code 37 环境异常（签名挑战，重试无用）" });
			rawPages.push({ page: p, url: r.url, body: r.json });
			break;
		}
		if (r.json?.code !== 0) {
			stopped = { kind: "api", message: `code=${r.json?.code} ${r.json?.message ?? ""}` };
			rawPages.push({ page: p, url: r.url, body: r.json ?? r.text?.slice(0, 800) });
			break;
		}

		const list = r.json?.zpData?.jobList ?? [];
		rawPages.push({ page: p, url: r.url, count: list.length });
		for (const item of list) collected.push(normalizeJob(item, profile));
		log(`第 ${p} 页：${list.length} 条（累计 ${collected.length}）`);
		if (list.length < pageSize) break;
		if (p < pages) await new Promise((res) => setTimeout(res, minDelay + Math.random() * (maxDelay - minDelay)));
	}

	// ── 撞上签名挑战（code 37）就换浏览器来发这个请求 ────────────────────────
	// Code 37 的响应体是 `{seed, name, ts}`：Boss 要的不是"你登录了没有"，
	// 而是"这个请求是不是它自己的页面发的"。那套算法在 Boss 的 JS bundle 里而且会变，
	// 硬逆向等于跟一个每天变的目标赛跑。换个思路：**让它的页面去发**，我们只截 JSON。
	//
	// 但默认**不**自动兜底：兜底会再打一次 Boss（开浏览器 + 发请求），
	// 而"别频繁测"比"少点一次"重要。要用显式开：--browser / browserFallback: true。
	const usedBrowser = stopped?.kind === "abnormal-env" && mode === "search" && opts.browserFallback === true;
	if (usedBrowser) {
		log("Node 直连被签名挑战挡了（code 37）→ 改用浏览器发这个搜索请求");
		try {
			const { browserSearch } = await import("./browser-search.mjs");
			const br = await browserSearch({ city, query, page: 1, log });
			rawPages.push({ browser: true, ok: br.ok, code: br.code, message: br.message, onPage: br.onPage, attempts: br.attempts });
			if (br.ok) {
				collected.length = 0; // 以浏览器这批为准
				for (const item of br.jobs) collected.push(normalizeJob(item, profile));
				stopped = null;
				log(`浏览器抓到 ${br.jobs.length} 条`);
			} else {
				stopped = {
					kind: "browser-blocked",
					message: `浏览器也没发出去：code=${br.code ?? "?"} ${br.message ?? ""}`
						+ (br.onPage?.includes("verify") ? ` —— 页面被弹到验证墙了，先跑 node boss/verify-browser.mjs 过一次真人验证` : ""),
					onPage: br.onPage ?? null,
				};
				markCooldown({ kind: "browser-blocked", message: "浏览器路径也不通（网页端不认这个登录态）" });
			}
		} catch (err) {
			stopped = { kind: "browser-error", message: `浏览器兜底失败：${String(err?.message ?? err).split("\n")[0]}` };
		}
	}

	// ── 合并进 data/jobs.json（按 id 去重）──────────────────────────────────
	let jobs = [];
	let added = 0;
	let updatedAt = null;
	if (save && collected.length > 0) {
		const jobsPath = join(DATA_DIR, "jobs.json");
		const prev = readJson(jobsPath, { version: 1, jobs: [] }) ?? { version: 1, jobs: [] };
		const byId = new Map((prev.jobs ?? []).map((j) => [j.id, j]));
		for (const j of collected) {
			const old = byId.get(j.id);
			if (old === undefined) added++;
			byId.set(j.id, { ...old, ...j, firstSeenAt: old?.firstSeenAt ?? j.scrapedAt, lastSeenAt: j.scrapedAt });
		}
		jobs = [...byId.values()];
		updatedAt = new Date().toISOString();
		writeJson(jobsPath, {
			version: 1, updatedAt,
			lastQuery: { mode, city, cityCode, query, maxKm, pages },
			count: jobs.length, jobs,
		});
	} else {
		jobs = (readJson(join(DATA_DIR, "jobs.json"), { jobs: [] })?.jobs ?? []);
	}

	if (rawPages.length > 0) {
		try {
			writeJson(join(RUNS_DIR, `${new Date().toISOString().replace(/[:.]/gu, "-")}-scrape.json`), {
				at: new Date().toISOString(), mode, city, cityCode, query, pages, rawPages,
			});
		} catch { /* 记原始响应失败不该影响结果 */ }
	}

	return {
		ok: stopped === null || collected.length > 0,
		mode, city, cityCode, query,
		fetched: collected.length,
		added,
		saved: save && collected.length > 0,
		total: jobs.length,
		jobs,
		stopped,
		usedBrowser,
		cooldown: readCooldown(),
		nearKm: maxKm === null ? null : filterJobs(jobs, { maxKm }).length,
	};
}
