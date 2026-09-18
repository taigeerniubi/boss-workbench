/**
 * Boss 抓取层 · 公共库
 *
 * 架构（照 mcp-boss-zp 的"分工"思路，不调它的服务）：
 *   浏览器只做一件 HTTP 做不到的事 —— 过安全验证、拿 __zp_stoken__、承载登录态；
 *   真正的数据全部走 wapi JSON 接口。好处是不依赖 DOM 选择器，
 *   Boss 改版只影响浏览器那一步，不影响解析。
 *
 * 一份会话 = 一个持久 profile（默认 browser-profile/），cookie 在里面，
 * 所以"过一次验证 + 扫一次码"能管很久。
 *
 * ── 运行期数据**一律不放仓库目录** ─────────────────────────────────────────
 * 登录凭证、浏览器 profile、简历原件、抓到的东西，全部落在
 *
 *     ~/.dsh/boss-workbench/          （和 ~/.dsh/.credentials.yaml 里的 key 并排）
 *       data/             session.json（登录凭证）、jobs.json、profile.json …
 *       browser-profile/  浏览器 persistent profile —— 里面同样是活的 cookie
 *       resumes/          简历原件
 *       runs/             Boss 原始响应、二维码、回放证据
 *
 * 为什么要这样：这些东西里任何一个被提交上去，就等于把账号送人，而且 Git 历史
 * 删不干净。放在仓库目录外面，是**结构上不可能误提交**，而不是"记得加 .gitignore"。
 * 想换地方：设 `BOSS_HOME=<目录>`。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Playwright 不在这里静态 import —— 见 playwright.mjs。只用 HTTP 的那半不需要它。
import { loadChromium } from "./playwright.mjs";

/** 代码所在目录（只放代码）。 */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 运行期数据的家。默认和 DSH 的 key 并排放在 ~/.dsh 下。 */
export const HOME_DIR = process.env.BOSS_HOME ?? join(homedir(), ".dsh", "boss-workbench");
export const DATA_DIR = join(HOME_DIR, "data");
export const RUNS_DIR = join(HOME_DIR, "runs");
export const RESUMES_DIR = join(HOME_DIR, "resumes");
export const PROFILE_DIR = join(HOME_DIR, "browser-profile");
export const SESSION_PATH = join(DATA_DIR, "session.json");
export const SITE = "https://www.zhipin.com";

/**
 * 从旧布局（数据放在仓库目录里）搬过来。
 *
 * 只**复制**不删除：搬完旧目录原样留着，你自己确认没问题了再删。
 * 只在新的位置还没有 session.json 时才动，免得覆盖你已经在新布局里登好的会话。
 */
export function migrateLegacyHome() {
	const legacy = [["data", DATA_DIR], ["resumes", RESUMES_DIR], ["runs", RUNS_DIR], [".boss-profile", PROFILE_DIR]];
	const moved = [];
	for (const [name, dest] of legacy) {
		const src = join(ROOT, name);
		if (!existsSync(src)) continue;
		if (existsSync(dest) && existsSync(join(dest, "session.json"))) continue; // 新家已经有会话了，别动
		if (existsSync(dest)) continue;
		try {
			cpSync(src, dest, { recursive: true });
			moved.push(`${name}/ → ${dest}`);
		} catch { /* 搬不动就算了，不影响新布局使用 */ }
	}
	return moved;
}

export function ensureDirs() {
	const moved = migrateLegacyHome();
	if (moved.length > 0) {
		console.log("已把旧的运行期数据搬到仓库目录外面：");
		for (const m of moved) console.log(`  ${m}`);
		console.log("（是复制的，旧目录还在，确认没问题后可以自己删掉）");
	}
	for (const d of [HOME_DIR, DATA_DIR, RUNS_DIR, RESUMES_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
export const readJson = (p, fallback = null) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
export const writeJson = (p, value) => {
	if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(value, null, 2), "utf8");
};

//#region 人的指纹
/**
 * 常见指纹伪装的补丁。注意：实测（probe-boss-access.mjs）**它过不了墙** ——
 * 墙认的是 IP + profile 信任，不是指纹。留着是为了让"过墙之后"的行为更像真人，
 * 不被后续的行为风控盯上；不要把它当成破墙手段。
 */
export const STEALTH = () => {
	Object.defineProperty(navigator, "webdriver", { get: () => undefined });
	Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
	Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
	Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
	Object.defineProperty(navigator, "plugins", {
		get: () => [{ name: "PDF Viewer" }, { name: "Chrome PDF Viewer" }, { name: "Chromium PDF Viewer" }],
	});
	window.chrome = window.chrome ?? { runtime: {}, app: { isInstalled: false }, csi: () => {}, loadTimes: () => {} };
	const orig = WebGLRenderingContext.prototype.getParameter;
	WebGLRenderingContext.prototype.getParameter = function (p) {
		if (p === 37445) return "Google Inc. (NVIDIA)";
		if (p === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
		return orig.call(this, p);
	};
};
export const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled", "--lang=zh-CN", "--no-first-run"];

/**
 * 系统代理（环境变量 → Windows 注册表）。
 * security-check 那一步要开浏览器去 zhipin.com —— 挂了梯子时浏览器也必须在代理后面，
 * 否则这一步连不上，表现成"登录最后一步失败"，很难查。
 */
export function systemProxy() {
	for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
		const v = process.env[k];
		if (typeof v === "string" && v !== "") return v.startsWith("http") ? v : `http://${v}`;
	}
	try {
		const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8" });
		if (!/ProxyEnable\s+REG_DWORD\s+0x1/u.test(out)) return null;
		const server = /ProxyServer\s+REG_SZ\s+(\S+)/u.exec(out)?.[1];
		if (server === undefined || server === "") return null;
		return server.startsWith("http") ? server : `http://${server}`;
	} catch {
		return null;
	}
}
//#endregion

/** 打开（或复用）Boss 专用 profile。headless 只适合已登录且未触发验证的日常抓取。 */
export async function openSession({ headless = true, slowMo = 0 } = {}) {
	ensureDirs();
	const chromium = await loadChromium();
	const proxy = systemProxy();
	const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
		headless,
		slowMo,
		viewport: { width: 1440, height: 900 },
		locale: "zh-CN",
		timezoneId: "Asia/Shanghai",
		args: LAUNCH_ARGS,
		// 挂了梯子时浏览器也要在代理后面，否则 security-check 那一步连不上
		...(proxy === null ? {} : { proxy: { server: proxy } }),
	});
	await ctx.addInitScript(STEALTH);
	const page = ctx.pages()[0] ?? (await ctx.newPage());
	return { ctx, page };
}

/**
 * 风控信号。code 35 = "您的IP地址存在异常行为."，这是**紧急刹车**：
 * 见到它必须立刻停手，继续打只会把分数推得更高。
 */
export const isFlagged = (json) =>
	json !== null && typeof json === "object" && (json.code === 35 || /IP地址存在异常|异常行为/u.test(String(json.message ?? "")));
//#endregion

//#region 城市 / 地点 / 距离
/**
 * 城市码。只内置两个**实测确认过**的（defaultcity.json 与搜索 URL 都印证过），
 * 其余一律走 data/cities.json 缓存 —— 宁可在缺城市时报错，也不塞一堆可能错的码。
 */
const BUILTIN_CITIES = { 北京: "101010100", 上海: "101020100" };
const citiesPath = () => join(DATA_DIR, "cities.json");

export function loadCities() {
	return { ...BUILTIN_CITIES, ...(readJson(citiesPath(), {}) ?? {}) };
}
/** 从 Boss 拉全量城市表并缓存。走 HTTP，不需要浏览器。 */
export async function refreshCities(session) {
	const r = await httpApi("/wapi/zpgeek/common/data/city/site.json", {}, session);
	if (isFlagged(r.json)) return { ok: false, reason: "flagged" };
	if (isLoggedOut(r.json)) return { ok: false, reason: "logged-out" };
	const list = r.json?.zpData?.hotCityList ?? r.json?.zpData?.cityList ?? r.json?.zpData ?? null;
	const map = {};
	const walk = (node) => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (node === null || typeof node !== "object") return;
		if (typeof node.name === "string" && typeof node.code === "number") map[node.name] = String(node.code);
		for (const v of Object.values(node)) walk(v);
	};
	walk(list);
	if (Object.keys(map).length === 0) return { ok: false, reason: "empty", raw: r.json };
	writeJson(citiesPath(), map);
	return { ok: true, count: Object.keys(map).length };
}
export function resolveCity(name) {
	const cities = loadCities();
	if (cities[name] !== undefined) return cities[name];
	const hit = Object.keys(cities).find((k) => k.startsWith(name) || name.startsWith(k));
	return hit === undefined ? null : cities[hit];
}

/** 两个经纬度之间的球面距离（km）。 */
export function haversineKm(a, b) {
	if (a === null || b === null) return null;
	const R = 6371;
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10;
}

/** 我的住址 / 默认搜索条件。距离是从它算出来的。 */
const profilePath = () => join(DATA_DIR, "profile.json");
/** 没写 data/profile.json 时的默认值。城市码只有 北京 / 上海 是内置确认过的。 */
export function loadProfile() {
	return {
		homeCity: "北京",
		homeGeo: null, // { lng, lat } —— 填了才能算距离
		homeAddress: "",
		keywords: ["后端开发"],
		maxKm: 10,
		...readJson(profilePath(), {}),
	};
}
export const saveProfile = (p) => writeJson(profilePath(), p);

/**
 * 把 Boss 的职位条目规范化成工作台的 Job。
 * ⚠️ 字段名诚实标注：`item` 的形状来自未登录状态下**没能拿到**的 joblist 响应，
 * 所以这里对候选字段做容错扫描，而不是假装知道确切名字。
 * 第一次成功抓到一条后，用 runs/ 里的原始样本把这里收敛成确定字段。
 */
export function normalizeJob(item, home) {
	const pick = (...keys) => {
		for (const k of keys) {
			const v = k.split(".").reduce((o, part) => (o == null ? undefined : o[part]), item);
			if (v !== undefined && v !== null && v !== "") return v;
		}
		return undefined;
	};
	const geoRaw = pick("jobGeo", "geo", "location", "gps");
	let geo = null;
	if (typeof geoRaw === "string" && geoRaw.includes(",")) {
		const [lng, lat] = geoRaw.split(",").map(Number);
		if (Number.isFinite(lng) && Number.isFinite(lat)) geo = { lng, lat };
	} else if (typeof pick("longitude", "lng") === "number" && typeof pick("latitude", "lat") === "number") {
		geo = { lng: pick("longitude", "lng"), lat: pick("latitude", "lat") };
	}
	// Boss 自己给的文本距离（"1.2km" / "500m"）优先，否则用住址和岗位坐标算
	const textDist = pick("distance", "jobDistance", "distanceDesc");
	let distanceKm = null;
	if (typeof textDist === "number") distanceKm = textDist > 100 ? Math.round(textDist / 100) / 10 : textDist;
	else if (typeof textDist === "string") {
		const m = /([\d.]+)\s*(km|公里|m|米)/iu.exec(textDist);
		if (m !== null) distanceKm = m[2].toLowerCase().startsWith("k") || m[2] === "公里" ? Number(m[1]) : Math.round(Number(m[1]) / 100) / 10;
	}
	if (distanceKm === null) distanceKm = haversineKm(home?.homeGeo ?? null, geo);
	// 第三条路：接口既不给距离也不给坐标时，查本地「商圈 → 坐标」表（data/geo.json）。
	// wapi 的 jobList 只有 cityName / areaDistrict，所以这张表常常是唯一的距离来源。
	if (distanceKm === null) {
		const table = readJson(join(DATA_DIR, "geo.json"), null);
		const district = pick("areaDistrict");
		const point = table !== null && typeof district === "string" ? table[district] : null;
		if (point !== null && point !== undefined && typeof point.lng === "number" && typeof point.lat === "number") {
			distanceKm = haversineKm(home?.homeGeo ?? null, point);
		}
	}

	const id = String(pick("encryptJobId", "jobId", "securityId") ?? "");
	return {
		id: id === "" ? `unknown-${Math.random().toString(36).slice(2, 10)}` : id,
		company: pick("brandName", "companyName", "brand.name") ?? "",
		title: pick("jobName", "jobTitle") ?? "",
		salary: pick("salaryDesc", "salary") ?? "面议",
		city: pick("cityName", "city") ?? home?.homeCity ?? "",
		area: [pick("areaDistrict"), pick("businessDistrict")].filter(Boolean).join("·"),
		distanceKm,
		geo,
		hr: pick("bossName", "hrName") ?? "",
		hrTitle: pick("bossTitle") ?? "",
		experience: pick("jobExperience", "experience") ?? "",
		degree: pick("jobDegree", "degree") ?? "",
		industry: pick("brandIndustry", "industry") ?? "",
		scale: pick("brandScaleName") ?? "",
		stage: pick("brandStageName") ?? "",
		welfare: pick("welfareList") ?? [],
		securityId: pick("securityId") ?? "",
		encryptJobId: pick("encryptJobId") ?? "",
		url: id === "" ? "" : `${SITE}/job_detail/${id}.html`,
		jd: pick("jobDescription", "postDescription", "jobDesc") ?? "",
		scrapedAt: new Date().toISOString(),
	};
}

/** 按距离/关键词过滤 —— 和 UI 上的筛选是同一套语义，放这里便于 agent 直接复用。 */
export function filterJobs(jobs, { cities = [], keywords = [], maxKm = null } = {}) {
	const kw = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
	return jobs.filter((j) => {
		if (cities.length > 0 && !cities.includes(j.city)) return false;
		if (maxKm !== null && (j.distanceKm === null || j.distanceKm > maxKm)) return false;
		if (kw.length > 0) {
			const hay = `${j.company} ${j.title} ${j.jd} ${j.industry}`.toLowerCase();
			if (!kw.some((k) => hay.includes(k))) return false;
		}
		return true;
	});
}
//#endregion

//#region 登录 / 设备指纹 / HTTP —— 照 mcp-boss-zp 的分工实现
/**
 * 分工（这是参考项目最值得抄的一点）：
 *   **浏览器只做 HTTP 做不到的一件事** —— 在 security-check 页上让 Boss 自己的 JS
 *   把 `__zp_stoken__` 写进 cookie；
 *   **其它全部走 HTTP**：扫码登录、职位列表、打招呼。
 *
 * 关键认知修正：安全验证**不需要人点**。我一开始以为要人工过滑块，那是因为我在
 * **未登录**状态下撞的是另一道墙（`/web/passport/zp/verify.html`）。
 * 拿到 dispatcher 下发的登录 cookie 之后，访问 security-check 页，
 * token 会由页面 JS 自动写入 —— 这就是它 README 里"自动完成安全验证"的真实含义。
 */

/**
 * `fp`（设备指纹）的输入是**固定常量**，不是从页面动态取的 —— 这点很关键，
 * 意味着整条登录链可以纯 HTTP 完成。算法：AES-128-CBC(key, iv=随机16) 后 base64(iv+密文)。
 *
 * ⚠️ 这两个常量是参考项目从它自己的会话里抓下来的。它们可能随 Boss 改版或跟会话绑定而失效；
 * 第一次真跑如果 dispatcher 拿不到 cookie，就是这里要重新抓。
 */
export const FP_PLAINTEXT = "8048b8676fb7d3d8952276e6e98e0bde.f2dc7a63c4b0fbfa4b51a07e2710cf83.fef7e750fc3a1e6327e8a880915aee9c.ae00f848beb1aa591d71d5a80dd3bd95";
export const FP_KEY_B64 = "clRwXUJBK1VKK0k0IWFbbQ==";

/** 生成 `fp`：base64( iv + AES-128-CBC(plaintext) )。每次调用都换一个随机 iv。 */
export function generateFp(plaintext = FP_PLAINTEXT, keyB64 = FP_KEY_B64) {
	const key = Buffer.from(keyB64, "base64");
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-128-cbc", key, iv);
	const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
	return Buffer.concat([iv, body]).toString("base64");
}

/**
 * security-check 页。seed / name / ts 同样是参考项目里抓下来的固定值。
 * callbackUrl 指回职位列表页 —— 验证通过后就落在那个页面上。
 */
export const SECURITY_CHECK_URL =
	`${SITE}/web/common/security-check.html?seed=ttttZij2JIIK%2BxUw73%2B6ZmzsaYKTbDQuIH6OR6Bm54o%3D&name=e331459e&ts=1762256958405&callbackUrl=` +
	encodeURIComponent(`${SITE}/web/geek/jobs`);

const sessionPath = () => join(DATA_DIR, "session.json");
/** 会话（cookie + bst）存文件，不进浏览器 profile：HTTP 层要用它，且方便你直接看。 */
export const loadSession = () => readJson(sessionPath(), null);
export const saveSession = (s) => writeJson(sessionPath(), { ...s, savedAt: new Date().toISOString() });
export const clearSession = () => writeJson(sessionPath(), null);

/** HTTP 层：Node 自己发请求，不需要浏览器。请求头照参考项目实测可用的那一套。 */
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 把 `k=v; k=v` 解析成 Map。同名的取**最后**一个（靠后的通常是新写的）。 */
export function parseCookieJar(cookie) {
	const jar = new Map();
	for (const pair of String(cookie ?? "").split("; ")) {
		if (!pair.includes("=")) continue;
		const i = pair.indexOf("=");
		jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
	}
	return jar;
}

/**
 * 一次 wapi 请求。
 *
 * ⚠️ **`zp_token` 头必须跟着 cookie 里的 `bst` 走，不能另存一份。** 这是踩过的坑：
 * security-check 那一步会把 `bst` **换成一个新值**，而我们把 dispatcher 给的那个旧值
 * 存进了 `session.bst` 并且一直拿它当 `zp_token` 头发。结果就是
 * **cookie 里的 bst 和 header 里的 zp_token 不是同一个值**，Boss 判定
 * `code 37 您的环境存在异常` —— 而同一时刻 `getUserInfo` 却回 code 0，
 * 于是表现成"明明登录着，就是搜不了岗位"，非常难查。
 *
 * 现在统一从这里取：有 cookie 就用 cookie 里的（唯一真相），没有才退回 session.bst。
 */
export async function httpApi(path, params = {}, session, { method = "GET", referer = `${SITE}/web/user/?ka=header-login` } = {}) {
	if (session === null || session === undefined) throw new Error("httpApi: 没有会话，先跑 node boss/login.mjs");
	const url = new URL(path.startsWith("http") ? path : SITE + path);
	for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
	if (!url.searchParams.has("_")) url.searchParams.set("_", String(Date.now()));
	const zpToken = parseCookieJar(session.cookie).get("bst") ?? session.bst ?? "";
	const res = await fetch(url, {
		method,
		redirect: "manual",
		headers: {
			Cookie: session.cookie,
			zp_token: zpToken,
			"User-Agent": UA,
			Referer: referer,
			Origin: SITE,
			accept: "application/json, text/plain, */*",
		},
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch { /* 有些接口回 HTML / 图片 */ }
	return { status: res.status, json, text, headers: res.headers, url: url.toString(), zpToken };
}

/** 登录态失效（code 7）和风控（code 35）要分开处理：前者重新登录，后者必须停手。 */
export const isLoggedOut = (json) => json !== null && typeof json === "object" && (json.code === 7 || /登录状态已失效|请先登录/u.test(String(json.message ?? "")));

/**
 * 当前登录态。
 *
 * ⚠️ **别用 `header.json` 的 `isLogin`。** 这是踩过的坑：
 * 实测同一时刻 `getUserInfo` 回 `code 0`（真登录态），而 `header.json` 的
 * `isLogin` 仍然是 `false` —— 它反映的是"这个网页文档登录了没有"，
 * 不是"这套 cookie 能不能用"。信它的后果就是：**明明登录着，工作台每次打开
 * 都弹二维码**（闸门以为没登录 → 去取码 → 又因为宿主流程停在 logged-in 而显示
 * "登录成功"，两句话自相矛盾）。
 *
 * 现在的判据是 `getUserInfo` 的 code：0 = 登录态，7 = 失效。
 */
export async function loginStateHttp(session) {
	const r = await httpApi("/wapi/zpuser/wap/getUserInfo.json", {}, session, { referer: `${SITE}/web/geek/chat` });
	const code = r.json?.code ?? null;
	if (code === 0) return { flagged: false, loggedIn: true, code, message: r.json?.message ?? "Success" };
	// code 7 = 登录状态已失效；其余（35 / 37 / 其它）照原样带出去，让上层决定怎么处理
	return {
		flagged: isFlagged(r.json),
		loggedIn: false,
		code,
		message: r.json?.message ?? r.text?.slice(0, 80),
	};
}

/**
 * 浏览器唯一的职责：带着登录 cookie 打开 security-check 页，
 * 等 Boss 自己的 JS 把 `__zp_stoken__` 写进去，然后读回来。
 *
 * **并且当场验证**。之前这一步只是"跑完了就宣布成功"，和参考项目一样 ——
 * 结果就是工作台上显示"登录成功"，可下一次请求 Boss 回 code 7（登录状态已失效）。
 * 现在这里必须拿到 getUserInfo 的 code 0 才算数，否则如实回报。
 */
export async function completeSecurityCheck(initialCookie, { log = () => {}, waitMs = 1500, dropStoken = false, onProgress = null } = {}) {
	const { ctx, page } = await openSession({ headless: true });
	try {
		const cookies = initialCookie
			.split("; ")
			.filter((pair) => pair.includes("="))
			.map((pair) => {
				const [name, ...rest] = pair.split("=");
				return {
					name: name.trim(),
					value: rest.join("="),
					domain: ".zhipin.com",
					path: "/",
					// 必须给 expires。不给的话这是**会话 cookie**，浏览器一关就没了，
					// 持久 profile 里存不下来 —— 下次打开 profile 就变成"没登录"。
					expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
				};
			});
		await ctx.addCookies(cookies);
		log(`  已注入 ${cookies.length} 个登录 cookie`);
		// 关键：把旧的 __zp_stoken__ 丢掉，逼 Boss 按**现在这个登录态**重新签发一个。
		// 留着旧的话（它往往是登录前那次匿名验证签的）会出现很怪的状态：
		// uid / name 都认得出来，但 isLogin=false、identity=-1、接口回 code 37「环境存在异常」。
		if (dropStoken) {
			await ctx.clearCookies({ name: "__zp_stoken__" });
			log("  已清掉旧的 __zp_stoken__（要重新签一个）");
		}
		await page.goto(SECURITY_CHECK_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

		/**
		 * 等 __zp_stoken__ 出现，**一出现就走**。
		 *
		 * 原来是 `waitForLoadState("networkidle")` + 死等 3 秒。实测两个都糟：
		 * 挂着代理时 security-check 页永远"不空闲"（有长连接/心跳），于是每次都白等
		 * 满 30 秒超时，再白等 3 秒 —— 这就是"扫码以后半天没反应"的全部原因。
		 * 实际 stoken 通常 1~2 秒内就写进去了，所以改成 250ms 轮询、见到即返回。
		 */
		let stoken = null;
		let waited = 0;
		const POLL_MS = 250;
		const DEADLINE = 20000;
		while (waited < DEADLINE) {
			const now = await ctx.cookies(SITE);
			stoken = now.find((c) => c.name === "__zp_stoken__") ?? null;
			if (stoken !== null && stoken.value.length > 20) break;
			await page.waitForTimeout(POLL_MS);
			waited += POLL_MS;
			if (waited % 2000 === 0) onProgress?.(`等 __zp_stoken__… 已 ${Math.round(waited / 1000)}s`);
		}
		// 兜底再等一小会儿：有些情况下 stoken 是页面加载完之后才写的
		if (stoken === null || stoken.value.length <= 20) {
			if (waitMs > 0) await page.waitForTimeout(waitMs);
		}
		log(waited >= DEADLINE ? `  等 stoken 到顶（${DEADLINE / 1000}s）` : `  等了 ${(waited / 1000).toFixed(1)}s`);

		// 主路径用 context.cookies()：它跨文档都能读，而且能看到 document.cookie 看不到的 httpOnly。
		// document.cookie 只作兜底 —— 有些文档（错误页 / 跨源 / opaque origin）会直接抛 SecurityError。
		// 传 SITE 让 Playwright 只回"对 zhipin.com 生效"的那批，能少带一堆别的域的 cookie。
		const all = await ctx.cookies(SITE);
		let jsCookies = "";
		try {
			jsCookies = await page.evaluate(() => document.cookie);
		} catch {
			log("  document.cookie 读不到（该文档不允许），改用 context.cookies()");
		}
		stoken = all.find((c) => c.name === "__zp_stoken__") ?? null;
		log(`  落在: ${page.url().slice(0, 110)}`);
		log(`  cookie 共 ${all.length} 个${all.length > 0 ? "：" + all.map((c) => c.name).join(",") : ""}`);
		log(stoken === undefined || stoken === null ? "  ⚠️ 没拿到 __zp_stoken__" : `  ✓ 拿到 __zp_stoken__（${stoken.value.length} 字节）`);

		// ── 拼 Cookie 头：**必须去重** ────────────────────────────────────
		// 同一个名字在 `.zhipin.com` 和 `www.zhipin.com` 下会各存一份，ctx.cookies() 两份都回。
		// 原样拼出来的头里就会有重复名字，服务端取哪一份是不确定的 —— 实测拼出过
		// `HMACCOUNT_BFESS=…; …; HMACCOUNT_BFESS=…` 这种，跟着就是 code 37「环境存在异常」。
		const merged = all.length > 0 ? effectiveCookieHeader(all).header : jsCookies;

		// ── 真凭实据：问一次 /wapi/zpuser/wap/getUserInfo.json ──────────────
		// ctx.request 和浏览器共用同一个 cookie jar，所以问的就是"浏览器现在这个身份"。
		onProgress?.("验证登录态…");
		const verify = { ok: false, code: null, message: null, user: null };
		try {
			const r = await ctx.request.get(`${SITE}/wapi/zpuser/wap/getUserInfo.json`, {
				headers: { referer: `${SITE}/web/geek/job-recommend`, accept: "application/json, text/plain, */*" },
				timeout: 15000,
			});
			const j = await r.json().catch(() => null);
			verify.code = j?.code ?? null;
			verify.message = j?.message ?? null;
			verify.ok = j?.code === 0;
			const u = j?.zpData?.userInfo ?? j?.zpData;
			if (verify.ok && u !== null && typeof u === "object") verify.user = u.name ?? u.nickName ?? u.uid ?? null;
		} catch (err) {
			verify.message = `验证请求失败：${String(err?.message ?? err).slice(0, 120)}`;
		}
		log(verify.ok ? `  ✓ 登录态已验证（getUserInfo code 0${verify.user === null ? "" : "，账号 " + String(verify.user)}）` : `  ✗ 登录态验证没过：code=${verify.code} ${verify.message ?? ""}`);

		return { stoken: stoken?.value ?? null, cookie: merged, url: page.url(), verify, deduped: effectiveCookieHeader(all).dropped };
	} finally {
		await ctx.close();
	}
}

/**
 * 把 Playwright 给的 cookie 列表拼成一条能直接放进 `Cookie:` 头的字符串，**按名字去重**。
 *
 * 同一个名字可能有多份（不同 domain / path）。选哪一份的规则：
 *   1. 域更"宽"的优先 —— `.zhipin.com` 比 `www.zhipin.com` 更可能挂着登录凭证；
 *   2. 路径是 `/` 的优先；
 *   3. 还并列就取**后面**那个（`ctx.cookies()` 里靠后的通常是刚写进去的）。
 *
 * 返回被丢掉的那些名字，方便在日志里说清楚"我替你做主了"。
 */
export function effectiveCookieHeader(cookies) {
	const rank = (c) => {
		let r = 0;
		if (c.domain === ".zhipin.com" || c.domain === "zhipin.com") r += 4;
		else if (typeof c.domain === "string" && c.domain.startsWith(".")) r += 2;
		if (c.path === "/") r += 1;
		return r;
	};
	const best = new Map();
	const dropped = [];
	for (const c of cookies) {
		if (typeof c?.name !== "string" || c.name === "") continue;
		const prev = best.get(c.name);
		if (prev === undefined) {
			best.set(c.name, c);
			continue;
		}
		// >= 而不是 >：并列时后面那个赢
		if (rank(c) >= rank(prev)) {
			dropped.push(`${c.name}（${prev.domain ?? "?"}${prev.path ?? ""} 让位给 ${c.domain ?? "?"}${c.path ?? ""}）`);
			best.set(c.name, c);
		} else {
			dropped.push(`${c.name}（${c.domain ?? "?"}${c.path ?? ""} 被丢掉，保留 ${prev.domain ?? "?"}${prev.path ?? ""}）`);
		}
	}
	return { header: [...best.values()].map((c) => `${c.name}=${c.value}`).join("; "), dropped, count: best.size };
}

/** 筛选枚举的代码表（取自参考项目，与 filter/conditions.json 一致）。 */
export const EXPERIENCE_MAP = { 在校生: 108, 应届生: 102, 不限: 101, 一年以内: 103, 一到三年: 104, 三到五年: 105, 五到十年: 106, 十年以上: 107 };
export const JOB_TYPE_MAP = { 全职: 1901, 兼职: 1903 };
export const SALARY_MAP = { "3k以下": 402, "3-5k": 403, "5-10k": 404, "10-20k": 405, "20-50k": 406, "50以上": 407 };
//#endregion
