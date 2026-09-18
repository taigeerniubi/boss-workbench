/**
 * 抓岗位的**可复用内核**。CLI（boss/scrape.mjs）和宿主路由（/boss/scrape）共用这一份。
 *
 * 拆出来的原因：UI 上点「抓取」和终端里敲命令必须是同一条代码路径。
 * 之前只有 CLI，工作台只能干看着 data/jobs.json，这就是"输入了没反应"的根。
 *
 * 三条硬约束原样保留（账号比数据重要）：
 *   1. 只复用现有 Chrome/Boss 页面，不创建隐身 profile，不走 Node 直连；
 *   2. code 35/36/37/403 立刻停，不重试、不换通道；
 *   3. 页数默认 1、上限 5，页间保留随机延时。
 */
import { join } from "node:path";
import { browserJson, classifyBossResponse, connectExistingBossBrowser } from "./browser-channel.mjs";
import {
	DATA_DIR, RUNS_DIR, ensureDirs, filterCode, filterJobs,
	EDUCATION_MAP, EXPERIENCE_MAP, INDUSTRY_MAP, JOB_TYPE_MAP, SALARY_MAP, SCALE_MAP, STAGE_MAP,
	loadProfile, markCooldown, normalizeJob, readCooldown, readJson,
	resolveCity, writeJson,
} from "./lib.mjs";

export const MAX_PAGES = 5;
export const SEARCH_PATH = "/wapi/zpgeek/search/joblist.json";
/** 推荐流。旧的 `/wapi/zpgeek/pc/recommend/job/list.json` 已不再被 Web 端使用。 */
export const RECOMMEND_PATH = "/wapi/zprelation/interaction/geekGetJob";
export const REFERER = {
	search: "https://www.zhipin.com/web/geek/job",
	recommend: "https://www.zhipin.com/web/geek/recommend",
};
/** 推荐流的响应把岗位放在 cardList 里（有的版本仍叫 jobList）。 */
const listFrom = (data) => data?.jobList ?? data?.cardList ?? [];

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
	const log = typeof opts.log === "function" ? opts.log : () => {};
	const mode = opts.mode === "recommend" ? "recommend" : "search";
	const city = opts.city ?? profile.homeCity;
	const query = opts.query ?? profile.keywords?.[0] ?? "";
	const pageSize = Math.min(Math.max(Number(opts.pageSize) || 30, 1), 30);
	const pages = Math.min(Math.max(Number(opts.pages) || 1, 1), MAX_PAGES);
	const minDelay = Number(opts.minDelay) || 5000;
	const maxDelay = Math.max(Number(opts.maxDelay) || 9000, minDelay);
	const maxKm = opts.maxKm ?? null;
	const save = opts.save !== false;

	// ── 冷却期：撞过风控就别再打了 ──────────────────────────────────────────
	// 风控按行为频率扣分，而人在排障时最容易做的就是"再试一次"。
	// 所以把"停手"做成规则：见过 code 35/37 之后这里直接拒绝执行。
	const cold = readCooldown();
	if (cold !== null && cold.expired === false) {
		const mins = Math.ceil(cold.remainingMs / 60000);
		return {
			ok: false,
			reason: "cooldown",
			error: `还在冷却期（约 ${mins} 分钟后解禁）。上一次撞到：${cold.message ?? cold.kind}。\n`
				+ `  风控是按频率扣分的，"再试一次"只会把分推得更高。`,
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
	let linked;
	try {
		// autoLaunch：浏览器被关掉之后，用户点「抓取岗位」就该自己再拉一个，
		// 而不是甩一句"连不上"让他去重启 GUI。重复触发由 browser-channel 的
		// 60 秒防抖闸门挡住（窗口关掉时闸门会复位）。
		linked = opts.transport === undefined ? await connectExistingBossBrowser({ autoLaunch: true }) : null;
	} catch (err) {
		return { ok: false, reason: err?.code ?? "browser", error: String(err?.message ?? err), fetched: 0, added: 0, jobs: [] };
	}
	if (opts.transport === undefined && linked?.loggedIn !== true) {
		return { ok: false, reason: "logged-out", error: "那个浏览器里的 Boss 还没登录，请在它打开的窗口里完成登录" };
	}
	const request = opts.transport?.request ?? ((path, params, options) => browserJson(linked.page, path, params, options));

	for (let p = 1; p <= pages; p++) {
		let path = SEARCH_PATH;
		let params;
		if (mode === "recommend") {
			// 推荐流只认 page / tag / isActive；筛选项由本地在抓回来之后施加。
			path = RECOMMEND_PATH;
			params = { page: p, tag: 5, isActive: "true" };
		} else {
			params = { scene: 1, query, city: cityCode, page: p, pageSize };
			// 只有"选中的维度"才带参数；标签先过字典翻成服务端码，翻不到就原样发（服务端会自己报错）。
			const maps = { experience: EXPERIENCE_MAP, degree: EDUCATION_MAP, salary: SALARY_MAP, industry: INDUSTRY_MAP, scale: SCALE_MAP, stage: STAGE_MAP, jobType: JOB_TYPE_MAP };
			for (const [key, map] of Object.entries(maps)) {
				const code = filterCode(map, opts[key]);
				if (code !== null) params[key] = code;
			}
		}

		let r;
		try {
			r = await request(path, params, { referer: REFERER[mode] });
		} catch (err) {
			stopped = { kind: err?.code ?? "browser", message: String(err?.message ?? err) };
			rawPages.push({ page: p, error: String(err?.message ?? err) });
			break;
		}

		const responseState = classifyBossResponse(r.json, r);
		if (responseState.kind !== "success") {
			stopped = { kind: responseState.kind, message: `code=${r.json?.code ?? r.status ?? "?"} ${r.json?.message ?? responseState.kind}` };
			if (["ip-risk", "account-risk", "environment-risk", "browser-blocked", "rate-limited"].includes(responseState.kind)) {
				markCooldown({ kind: responseState.kind, message: stopped.message });
			}
			rawPages.push({ page: p, url: r.url, code: r.json?.code ?? null, message: r.json?.message ?? responseState.kind });
			break;
		}

		const list = listFrom(r.json?.zpData ?? {});
		rawPages.push({ page: p, url: r.url, count: list.length });
		for (const item of list) collected.push(normalizeJob(item, profile));
		log(`第 ${p} 页：${list.length} 条（累计 ${collected.length}）`);
		if (list.length < pageSize) break;
		if (p < pages) await new Promise((res) => setTimeout(res, minDelay + Math.random() * (maxDelay - minDelay)));
	}

	const usedBrowser = true;

	// ── 距离是**本地**筛的：服务端没有 maxKm 参数 ──────────────────────────
	// 之前这里只把 maxKm 原样写进 lastQuery 就完事，"筛选"其实没落到结果上，
	// 界面上的距离下拉因此形同虚设。现在真正过一遍 filterJobs，
	// 并且把"被距离筛掉多少"如实报出来，免得用户以为 Boss 没岗位。
	const distanceOk = maxKm === null ? collected : filterJobs(collected, { maxKm });
	const droppedByDistance = collected.length - distanceOk.length;

	// ── 合并进 data/jobs.json（按 id 去重）──────────────────────────────────
	let jobs = [];
	let added = 0;
	let updatedAt = null;
	if (save && distanceOk.length > 0) {
		const jobsPath = join(DATA_DIR, "jobs.json");
		const prev = readJson(jobsPath, { version: 1, jobs: [] }) ?? { version: 1, jobs: [] };
		const byId = new Map((prev.jobs ?? []).map((j) => [j.id, j]));
		for (const j of distanceOk) {
			const old = byId.get(j.id);
			if (old === undefined) added++;
			byId.set(j.id, { ...old, ...j, firstSeenAt: old?.firstSeenAt ?? j.scrapedAt, lastSeenAt: j.scrapedAt });
		}
		jobs = [...byId.values()];
		updatedAt = new Date().toISOString();
		writeJson(jobsPath, {
			version: 1, updatedAt,
			lastQuery: { mode, city, cityCode, query, maxKm, pages, filters: { experience: opts.experience ?? null, degree: opts.degree ?? null, salary: opts.salary ?? null, industry: opts.industry ?? null, scale: opts.scale ?? null, stage: opts.stage ?? null, jobType: opts.jobType ?? null } },
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
		ok: stopped === null || distanceOk.length > 0,
		mode, city, cityCode, query,
		fetched: distanceOk.length,
		fetchedJobs: distanceOk,
		rawFetched: collected.length,
		droppedByDistance,
		added,
		saved: save && distanceOk.length > 0,
		total: jobs.length,
		jobs,
		stopped,
		usedBrowser,
		cooldown: readCooldown(),
		nearKm: maxKm === null ? null : distanceOk.length,
	};
}
