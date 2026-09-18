/**
 * Boss 直聘工作台 — node 半边。**宿主 ↔ 客户端的那座桥**。
 *
 * 为什么用 HTTP 路由而不是 RPC：
 *   查过 DSH 的两条既有通道，都不适合 out-of-tree 插件 ——
 *   - `typert` remote 需要在 `dsh-api-remotes` 里显式注册，还要 tsdown 生成 `/remote` 产物，
 *     那是 core 包 + 构建期的事，外部插件碰不到；
 *   - `ctx.remote.$mount()` 同理。
 *   而 `ctx.webServer.register({kind:"prefix"})` 是**任何插件都能调**的公开 API
 *   （`dsh-client-modules` 自己就是这么挂 `/plugins` 的）；客户端同源 fetch 就能调，
 *   鉴权交给 `ctx.connection.isAuthenticated(req)` —— 它校验的正是浏览器里那个签名 cookie。
 *
 * 本文件提供这些事：
 *   GET  /boss/state                读：简历索引 + 岗位 + profile + 登录态
 *   POST /boss/scrape               写：按城市/关键词/距离真去 Boss 抓一批岗位（和 CLI 同一个内核）
 *   POST /boss/resumes/upload       写：上传简历（原始字节）→ 落盘 → 解析 → 回结构化结果
 *   POST /boss/resumes/rescan|delete
 *   POST /boss/greet/preview|send   打招呼：生成话术（纯函数）/ 真发出去（走 wapi）
 *
 * `/boss` 前缀由 webServer 的最长前缀匹配独占，不会碰到 shell 自己的路由。
 */
import { join } from "node:path";
import { DATA_DIR, RESUMES_DIR, loadProfile, loadSession, loginStateHttp, readCooldown, readJson, writeJson } from "../../boss/lib.mjs";
import { fetchBalance } from "../../boss/balance.mjs";
import { loginState, logout, pollLogin, startLogin } from "../../boss/loginflow.mjs";
import { buildGreeting, sendGreeting } from "../../boss/greet.mjs";
import { buildIndex, readIndex, removeResume, saveUpload } from "../../boss/resumes.mjs";
import { runScrape } from "../../boss/jobs.mjs";

const PREFIX = "/boss";
const MAX_UPLOAD = 32 * 1024 * 1024;
const MAX_JOBS = 400;

//#region HTTP 小工具
const sendJson = (res, status, value) => {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
};
const sendText = (res, status, text) => {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
	res.end(text);
};
async function readBody(req, limit = MAX_UPLOAD) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB`);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
async function readJsonBody(req) {
	const buf = await readBody(req, 1024 * 1024);
	try {
		return JSON.parse(buf.toString("utf8"));
	} catch {
		return {};
	}
}
/** 只认"本机 + 已认证的浏览器 cookie"；没有 connection 服务时退化成只允许 loopback。 */
function isTrusted(ctx, req) {
	const connection = ctx.get("connection");
	if (connection !== undefined && typeof connection.isAuthenticated === "function") return connection.isAuthenticated(req);
	const addr = req.socket?.remoteAddress ?? "";
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
/** 岗位只回卡片与详情需要的字段，别把整份原始响应推给浏览器。 */
const trimJob = (j) => ({
	id: j.id, company: j.company, title: j.title, salary: j.salary, city: j.city, area: j.area,
	distanceKm: j.distanceKm, hr: j.hr, industry: j.industry, experience: j.experience, degree: j.degree,
	securityId: j.securityId, encryptJobId: j.encryptJobId, url: j.url, jd: (j.jd ?? "").slice(0, 4000),
	scrapedAt: j.scrapedAt,
});
/** 选哪份简历：指定 → 默认 → 第一份能用的。 */
function pickResume(index, name) {
	const parsed = (index?.files ?? []).filter((f) => f.status === "parsed");
	if (parsed.length === 0) return null;
	if (typeof name === "string" && name !== "") return parsed.find((f) => f.name === name) ?? parsed[0];
	return parsed.find((f) => f.name === index.defaultResume) ?? parsed[0];
}
/** data/jobs.json 是岗位的唯一真相，读它的地方统一走这里。 */
const readJobsFile = () => readJson(join(DATA_DIR, "jobs.json"), null);
/** 岗位按"最近抓到的"排前面，再截断。 */
const stateJobs = (limit = MAX_JOBS) =>
	(readJobsFile()?.jobs ?? [])
		.slice()
		.sort((a, b) => String(b.scrapedAt ?? "").localeCompare(String(a.scrapedAt ?? "")))
		.slice(0, limit)
		.map(trimJob);
const findJob = (id) => (readJobsFile()?.jobs ?? []).find((j) => j.id === id);
//#endregion

//#region 路由
async function handle(ctx, req, res) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname.slice(PREFIX.length) || "/";
	const method = req.method ?? "GET";
	if (!isTrusted(ctx, req)) return sendText(res, 401, "unauthorized");

	// ── 读：一次给全，客户端不用多次往返 ─────────────────────────────────
	if (method === "GET" && path === "/state") {
		const jobsFile = readJobsFile();
		const session = loadSession();
		return sendJson(res, 200, {
			ok: true,
			resumes: readIndex(),
			jobs: stateJobs(),
			jobsUpdatedAt: jobsFile?.updatedAt ?? null,
			lastQuery: jobsFile?.lastQuery ?? null,
			profile: loadProfile(),
			session: session === null ? { present: false } : { present: true, hasStoken: Boolean(session.stoken), savedAt: session.savedAt ?? null },
			// 冷却期：撞过风控就锁上。界面要能看见"为什么现在不让我抓"
			cooldown: readCooldown(),
			resumesDir: RESUMES_DIR,
		});
	}

	// ── 抓岗位：工作台的「搜索 / 抓取」按钮打到这里，和 CLI 是同一个 runScrape ——
	// 刻意用 HTTP 200 + ok:false 表达"业务上没抓到"（没登录 / 没有城市码 / 撞风控），
	// 让客户端能把原因原样显示出来；只有真抛异常才会落到外层的 500。
	if (method === "POST" && path === "/scrape") {
		const body = await readJsonBody(req);
		const r = await runScrape({
			mode: body.mode,
			city: typeof body.city === "string" && body.city !== "" ? body.city : undefined,
			query: typeof body.query === "string" ? body.query : undefined,
			maxKm: body.maxKm ?? null,
			pages: body.pages ?? 1,
			pageSize: body.pageSize,
			experience: body.experience,
			jobType: body.jobType,
			salary: body.salary,
			save: body.save !== false,
		});
		const jobsFile = readJobsFile();
		return sendJson(res, 200, {
			ok: r.ok === true,
			reason: r.reason ?? null,
			error: r.error ?? null,
			stopped: r.stopped ?? null,
			fetched: r.fetched ?? 0,
			added: r.added ?? 0,
			total: jobsFile?.count ?? 0,
			mode: r.mode ?? null,
			city: r.city ?? null,
			query: r.query ?? null,
			jobs: stateJobs(),
			jobsUpdatedAt: jobsFile?.updatedAt ?? null,
			lastQuery: jobsFile?.lastQuery ?? null,
		});
	}

	// ── 登录：没登录就让工作台先把二维码弹出来 ──────────────────────────────
	if (method === "GET" && path === "/login/state") {
		return sendJson(res, 200, { ok: true, ...(await loginState({ force: url.searchParams.get("force") === "1" })) });
	}
	if (method === "POST" && path === "/login/start") {
		const r = await startLogin({ force: url.searchParams.get("force") === "1" });
		return sendJson(res, r.ok ? 200 : 502, r);
	}
	if (method === "GET" && path === "/login/status") {
		return sendJson(res, 200, { ok: true, ...(await pollLogin()) });
	}
	// 退出登录：清 session.json + 清浏览器 profile 的 cookie + 复位状态机
	if (method === "POST" && path === "/logout") {
		return sendJson(res, 200, await logout());
	}

	// ── 账号余额（还剩多少钱）。宿主半边持有 key，浏览器只拿数字 ────────────
	if (method === "GET" && path === "/balance") {
		return sendJson(res, 200, await fetchBalance(ctx, { force: url.searchParams.get("force") === "1" }));
	}

	// ── 写：上传简历（原始字节在 body，文件名在 query）────────────────────
	if (method === "POST" && path === "/resumes/upload") {
		const name = url.searchParams.get("name");
		if (name === null || name === "") return sendJson(res, 400, { ok: false, error: "缺少文件名" });
		let bytes;
		try {
			bytes = await readBody(req);
		} catch (err) {
			return sendJson(res, 413, { ok: false, error: String(err.message) });
		}
		if (bytes.length === 0) return sendJson(res, 400, { ok: false, error: "空文件" });
		let saved;
		try {
			saved = saveUpload(name, bytes);
		} catch (err) {
			return sendJson(res, 500, { ok: false, error: `落盘失败: ${String(err.message)}` });
		}
		const index = buildIndex();
		const entry = index.files.find((f) => f.name === name || f.path === saved) ?? null;
		return sendJson(res, 200, { ok: true, saved, entry, index });
	}

	if (method === "POST" && path === "/resumes/rescan") return sendJson(res, 200, { ok: true, index: buildIndex() });

	if (method === "POST" && path === "/resumes/delete") {
		const { name } = await readJsonBody(req);
		if (typeof name !== "string" || name === "") return sendJson(res, 400, { ok: false, error: "缺少 name" });
		return sendJson(res, 200, { ok: true, removed: removeResume(name), index: buildIndex() });
	}

	// ── 打招呼：预览是纯函数（不联网），发送才真发 ────────────────────────
	if (method === "POST" && path === "/greet/preview") {
		const { jobId, resumeName } = await readJsonBody(req);
		const resume = pickResume(readIndex(), resumeName);
		if (resume === null) return sendJson(res, 400, { ok: false, error: "简历库里还没有解析成功的简历" });
		const job = findJob(jobId);
		if (job === undefined) return sendJson(res, 404, { ok: false, error: `岗位 ${jobId} 不在 data/jobs.json 里` });
		return sendJson(res, 200, { ok: true, resumeName: resume.name, greeting: buildGreeting({ resume: resume.structured, job, profile: loadProfile() }) });
	}

	if (method === "POST" && path === "/greet/send") {
		const { jobId, text, resumeName } = await readJsonBody(req);
		const session = loadSession();
		if (session === null) return sendJson(res, 400, { ok: false, error: "还没有登录会话，先跑 node boss/login.mjs" });
		const job = findJob(jobId);
		if (job === undefined) return sendJson(res, 404, { ok: false, error: `岗位 ${jobId} 不在 data/jobs.json 里` });
		const resume = pickResume(readIndex(), resumeName);
		const greeting = typeof text === "string" && text.trim() !== "" ? { text } : buildGreeting({ resume: resume?.structured ?? {}, job, profile: loadProfile() });

		const state = await loginStateHttp(session);
		if (state.flagged) return sendJson(res, 429, { ok: false, error: "风控 code 35（IP 异常）—— 停手，等冷却" });
		if (!state.loggedIn) return sendJson(res, 401, { ok: false, error: "登录态失效，重新跑 node boss/login.mjs" });
		const r = await sendGreeting(session, { securityId: job.securityId, jobId: job.encryptJobId || job.id });

		// 成功失败都留档，方便在 runs/ 回看
		try {
			const log = readJson(join(DATA_DIR, "greetings.json"), { version: 1, items: [] }) ?? { version: 1, items: [] };
			log.items.unshift({
				at: new Date().toISOString(), jobId, company: job.company, title: job.title,
				resumeName: resume?.name ?? null, text: greeting.text, ok: r.ok, error: r.error ?? null,
			});
			writeJson(join(DATA_DIR, "greetings.json"), { ...log, items: log.items.slice(0, 500) });
		} catch { /* 记日志失败不该影响发送结果 */ }

		return sendJson(res, r.ok ? 200 : 502, { ok: r.ok, error: r.error ?? null, text: greeting.text, data: r.data ?? null });
	}

	return sendText(res, 404, `no such boss route: ${method} ${path}`);
}
//#endregion

/** 宿主插件主体：把 `/boss` 前缀挂到 webServer 上。 */
export function apply(ctx) {
	const register = (scoped) => {
		scoped.effect(
			() =>
				scoped.webServer.register({
					kind: "prefix",
					path: PREFIX,
					handler: (req, res) => {
						handle(scoped, req, res).catch((err) => {
							scoped.logger?.warn?.(err);
							if (res.headersSent) res.end();
							else sendText(res, 500, `boss route failed: ${String(err?.message ?? err)}`);
						});
					},
				}),
			"boss-workbench: /boss route",
		);
	};
	// webServer 可能比本插件晚激活（dsh-client-modules 也是这么等的）
	if (ctx.get("webServer") === undefined) ctx.inject(["webServer"], register);
	else register(ctx);
}
