/**
 * 复用用户已经打开的 Chrome/BOSS 会话。
 *
 * 这套实现只搬运行为策略：CDP 连接现有浏览器、复用现有 context/page、在页面里
 * fetch。它不引用 boss-agent-cli 的包、文件或运行时。
 */
import { loadChromium } from "./playwright.mjs";
import { ensureDebuggableChrome, probeCdp, readLaunchRecord } from "./auto-chrome.mjs";
import { SITE, effectiveCookieHeader } from "./lib.mjs";

export const DEFAULT_CDP_URL = process.env.BOSS_CDP_URL ?? "http://127.0.0.1:9222";

export class BrowserSessionError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "BrowserSessionError";
		this.code = code;
	}
}

export function assertLoopbackCdpUrl(raw) {
	let url;
	try { url = new URL(raw); } catch { throw new BrowserSessionError("BAD_CDP_URL", "CDP 地址无效"); }
	const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
	if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
		throw new BrowserSessionError("BAD_CDP_URL", "CDP 只允许连接本机 http 地址");
	}
	return url.toString().replace(/\/$/u, "");
}

const isBossUrl = (value) => {
	try { return new URL(value).hostname.endsWith("zhipin.com"); } catch { return false; }
};

/** 选中含 wt2 的 context；页面优先复用用户已经打开的 Boss 标签。 */
export async function selectExistingBossSession(contexts) {
	let fallback = null;
	let fallbackRank = -1;
	for (const context of contexts) {
		const pages = typeof context.pages === "function" ? context.pages() : [];
		const bossPage = pages.find((page) => isBossUrl(page.url())) ?? null;
		const cookies = await context.cookies(SITE).catch(() => []);
		const loggedIn = cookies.some((cookie) => cookie.name === "wt2" && String(cookie.value).length > 0);
		const candidate = { context, page: bossPage, cookies, loggedIn };
		if (loggedIn && bossPage !== null) return candidate;
		const rank = loggedIn ? 2 : bossPage !== null ? 1 : 0;
		if (rank > fallbackRank) { fallback = candidate; fallbackRank = rank; }
	}
	return fallback;
}

let cached = null;
/**
 * 自动拉起的**防抖闸门**。
 *
 * 以前这里是"每进程只试一次"，本意是别每次读状态都去 spawn。但它有个真 bug：
 * **用户把窗口关掉之后，这个变量没有复位**，于是插件永远认为"已经试过了"，
 * 再也不会自己拉 —— 用户看到的就是"搜不了了"，只能重启 GUI。
 *
 * 改成两道：
 *   1. 时间防抖：60 秒内不重复尝试（挡住"读一次状态就 spawn 一次"的抖动）；
 *   2. 连接断开时复位（见下面的 disconnected 处理）—— 窗口被关掉是**新情况**，该重试。
 */
const AUTO_LAUNCH_COOLDOWN_MS = 60 * 1000;
let autoLaunchAttemptedAt = 0;
const autoLaunchAllowed = () => Date.now() - autoLaunchAttemptedAt >= AUTO_LAUNCH_COOLDOWN_MS;

/**
 * 现在监听着的这个调试口，后面是不是**无头**实例。
 *
 * 两个判据取「或」：/json/version 回的 UA 带 HeadlessChrome（用户手动起的无头会露这个）；
 * 或者插件自己的拉起记录说上次是 hidden 模式且端口一致（插件拉的会把 UA 抹掉，只能靠记录）。
 */
export async function isHeadlessAt(port, { fetchImpl = null, record = null } = {}) {
	const probe = await probeCdp(port, { fetchImpl });
	if (!probe.up) return { up: false, headless: false };
	if (/HeadlessChrome/u.test(String(probe.userAgent ?? ""))) return { up: true, headless: true, why: "ua" };
	const rec = record ?? readLaunchRecord();
	if (rec?.mode === "hidden" && Number(rec.port) === Number(port)) return { up: true, headless: true, why: "record" };
	return { up: true, headless: false };
}

/**
 * 让调试口后面那个浏览器整个退出（CDP `Browser.close`，浏览器自己走正常关闭流程，
 * 不是杀进程）。只用于「无头 → 可见」的切换：扫码登录需要一个看得见的窗口，而同一个
 * profile 不能同时跑两个实例。等到端口真的不在了才返回。
 */
export async function closeBrowserAt(cdpUrl, { chromium: suppliedChromium = null, fetchImpl = null, waitMs = 6000 } = {}) {
	const safeUrl = assertLoopbackCdpUrl(cdpUrl);
	const port = Number(new URL(safeUrl).port || 80);
	const chromium = suppliedChromium ?? await loadChromium();
	try {
		const browser = await chromium.connectOverCDP(safeUrl, { timeout: 5000 });
		try {
			const session = await browser.newBrowserCDPSession();
			await session.send("Browser.close");
		} catch { /* 有的实现关到一半就断连，下面靠探测兜底 */ }
	} catch { /* 连不上就当它已经不在了 */ }
	if (cached?.cdpUrl === safeUrl) cached = null;
	autoLaunchAttemptedAt = 0;
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		const probe = await probeCdp(port, { fetchImpl });
		if (!probe.up) return { ok: true };
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return { ok: false, error: `浏览器在 ${Math.round(waitMs / 1000)} 秒内没有退出` };
}

/**
 * 连现有 Chrome；**连不上就先把 Chrome 拉起来再连一次**。
 *
 * `autoLaunch` 只在"用户没在操作、只是打开工作台看状态"时打开（`/boss/state`）。
 * 每次抓取/读取会话都去 spawn 一次浏览器是不对的。
 *
 * `visible: true` 是扫码登录专用：要求连上的必须是**有窗口**的实例。默认拉起是隐藏模式
 * （见 auto-chrome 的 chromeMode），此时若端口后面是无头实例，就先让它退出、再以可见模式
 * 重拉 —— 同一个 profile 起第二个可见实例只会被合并进无头的那个，窗口永远出不来。
 */
export async function connectExistingBossBrowser({ cdpUrl = DEFAULT_CDP_URL, chromium: suppliedChromium = null, requirePage = true, autoLaunch = false, visible = false } = {}) {
	const safeUrl = assertLoopbackCdpUrl(cdpUrl);
	const chromium = suppliedChromium ?? await loadChromium();
	if (visible) {
		const state = await isHeadlessAt(Number(new URL(safeUrl).port || 80));
		if (state.up && state.headless) {
			const closed = await closeBrowserAt(safeUrl, { chromium });
			if (!closed.ok) throw new BrowserSessionError("CDP_UNAVAILABLE", `需要一个可见的浏览器窗口来扫码，但现有的隐藏实例没能退出：${closed.error}`);
		}
		// 需要可见窗口 = 一定允许拉起（不然连不上就只剩报错）
		autoLaunch = true;
	}
	if (cached?.browser?.isConnected?.()) {
		const picked = await selectExistingBossSession(cached.browser.contexts());
		if (picked !== null && (!requirePage || picked.page !== null)) return { ...picked, browser: cached.browser, cdpUrl: safeUrl };
	}
	/** 自动拉起可能落在别的端口上（9222 被别的调试器占着），所以连接地址要跟着 boot 结果走。 */
	let effectiveUrl = safeUrl;
	let browser;
	try {
		browser = await chromium.connectOverCDP(safeUrl, { timeout: 5000 });
	} catch {
		// 连不上通常是两种情况之一：① 浏览器没带调试参数启动；② 压根没开着（或被关掉了）。
		// 与其让用户去敲命令行，不如插件自己起一个（挑没在跑的浏览器 + 插件自己的 profile）。
		let boot = null;
		if (autoLaunch && autoLaunchAllowed()) {
			autoLaunchAttemptedAt = Date.now();
			boot = await ensureDebuggableChrome({ port: Number(new URL(safeUrl).port || 80), mode: visible ? "normal" : null });
			if (!boot.ok) throw new BrowserSessionError("CDP_UNAVAILABLE", describeBootFailure(boot));
			effectiveUrl = `http://127.0.0.1:${boot.port}`;
		}
		if (boot === null) {
			const waiting = Math.ceil((AUTO_LAUNCH_COOLDOWN_MS - (Date.now() - autoLaunchAttemptedAt)) / 1000);
			throw new BrowserSessionError(
				"CDP_UNAVAILABLE",
				`没有找到可复用的浏览器调试会话（${safeUrl}）。` +
					`${autoLaunch ? `刚试过一次自动拉起，${waiting} 秒后会自动再试（或点「帮我启动浏览器」立刻重试）。` : "插件会在打开工作台时自己拉起一个带调试口的浏览器。"}` +
					`一直不成功可以用 BOSS_CHROME_PATH 指定浏览器，或按 README「启动真实 Chrome 会话」那节手动启动。` +
					`另外：插件默认以隐藏模式（无窗口）拉起浏览器；若设了 BOSS_CHROME_MODE=normal，**关掉那个窗口就等于断掉插件的通道**，抓取和读会话都需要它开着。`,
			);
		}
		try {
			// 冷启动的浏览器需要一点时间把 context 建起来
			await new Promise((resolve) => setTimeout(resolve, 800));
			browser = await chromium.connectOverCDP(effectiveUrl, { timeout: 8000 });
		} catch (err2) {
			throw new BrowserSessionError(
				"CDP_UNAVAILABLE",
				`${boot.name ?? "浏览器"} 的调试口已经在 ${effectiveUrl} 监听了，但 Playwright 连不上它：${String(err2?.message ?? err2)}\n` +
					`（这通常是 Playwright 没装好，而不是浏览器的问题：npm i -D playwright）`,
			);
		}
	}
	cached = { browser, cdpUrl: effectiveUrl };
	browser.on?.("disconnected", () => {
		if (cached?.browser === browser) cached = null;
		// 窗口被关掉是**新情况**：清掉防抖时间戳，让下一次请求可以重新拉起。
		// 不复位的话插件会永远认为"已经试过了"，用户只能重启 GUI —— 这就是"搜不了了"。
		autoLaunchAttemptedAt = 0;
	});
	const picked = await selectExistingBossSession(browser.contexts());
	if (picked === null) throw new BrowserSessionError("BROWSER_SESSION_NOT_FOUND", "浏览器里没有可复用的 Boss 页面或登录态");
	if (requirePage && picked.page === null) throw new BrowserSessionError("BOSS_PAGE_NOT_FOUND", "浏览器已登录 Boss，但没有打开 Boss 页面；请先打开职位页再重试");
	return { ...picked, browser, cdpUrl: effectiveUrl };
}

/** 自动拉起失败时，把"能做什么"讲成人话。 */
function describeBootFailure(boot) {
	const lines = [
		boot.error ?? "没能拉起可调试的 Chrome",
	];
	if (boot.path) lines.push(`用到的浏览器：${boot.path}${boot.mode === "hidden" ? "（隐藏模式）" : ""}`);
	if (Array.isArray(boot.tried) && boot.tried.length > 0) lines.push(`找过这些位置：\n  ${boot.tried.join("\n  ")}`);
	if (boot.mode === "hidden") lines.push("当前是隐藏模式（默认）。如果它起不来，设 BOSS_CHROME_MODE=normal 回到可见窗口再试一次。");
	lines.push("也可以在「设置 → 环境变量」里给 BOSS_CHROME_PATH 指定 chrome.exe 的绝对路径，或设 BOSS_AUTO_CHROME=0 关掉自动拉起。");
	return lines.join("\n");
}

/** 给测试用：看清防抖闸门的当前状态。 */
export function autoLaunchState() {
	return { attemptedAt: autoLaunchAttemptedAt, allowed: autoLaunchAllowed(), cooldownMs: AUTO_LAUNCH_COOLDOWN_MS };
}

/** 供测试重置每进程状态。 */
export function resetAutoLaunchForTests() {
	autoLaunchAttemptedAt = 0;
	cached = null;
}

/** 在现有页面的 JS 环境中只发一次 fetch；cookie、浏览器指纹和出口网络自然一致。 */
export async function browserJson(page, path, params = {}, { method = "GET", body = null, referer = null, form = false } = {}) {
	if (page === null || page === undefined) throw new BrowserSessionError("BOSS_PAGE_NOT_FOUND", "没有可复用的 Boss 页面");
	const url = new URL(path.startsWith("http") ? path : SITE + path);
	for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
	if (!url.searchParams.has("_")) url.searchParams.set("_", String(Date.now()));
	return page.evaluate(async (input) => {
		const headers = { accept: "application/json, text/plain, */*", "x-requested-with": "XMLHttpRequest" };
		if (input.body !== null) headers["content-type"] = input.form ? "application/x-www-form-urlencoded;charset=UTF-8" : "application/json";
		const payload = input.body === null ? undefined : input.form ? new URLSearchParams(input.body).toString() : JSON.stringify(input.body);
		const response = await fetch(input.url, {
			method: input.method,
			credentials: input.credentials,
			referrer: input.referer || undefined,
			referrerPolicy: "strict-origin-when-cross-origin",
			headers,
			body: payload,
		});
		const text = await response.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* HTML 风控页会走这里 */ }
		return { status: response.status, url: response.url, json, text: json === null ? text.slice(0, 1000) : "" };
	}, { url: url.toString(), method, body, referer, form, credentials: "include" });
}

export function classifyBossResponse(json, { status = 200, url = "" } = {}) {
	const code = Number(json?.code);
	const message = String(json?.message ?? "");
	if (status === 403 || /\/403\.html|\/verify\.html/u.test(url)) return { kind: "browser-blocked", terminal: true };
	if (code === 0) return { kind: "success", terminal: false };
	if (code === 7 || /登录状态已失效|请先登录/u.test(message)) return { kind: "logged-out", terminal: true };
	if (code === 35) return { kind: "ip-risk", terminal: true };
	if (code === 36) return { kind: "account-risk", terminal: true };
	if (code === 37) {
		if (/token.*(?:失效|过期)|登录态.*(?:失效|过期)/iu.test(message)) return { kind: "logged-out", terminal: true };
		return { kind: "environment-risk", terminal: true };
	}
	if (code === 9 || status === 429) return { kind: "rate-limited", terminal: true };
	return { kind: "api-error", terminal: false };
}

export async function existingBrowserStatus(opts = {}) {
	try {
		const linked = await connectExistingBossBrowser({ ...opts, requirePage: false });
		return { ok: true, connected: true, loggedIn: linked.loggedIn, hasPage: linked.page !== null, cdpUrl: linked.cdpUrl };
	} catch (err) {
		return { ok: false, connected: false, loggedIn: false, hasPage: false, code: err?.code ?? "CDP_ERROR", error: String(err?.message ?? err), cdpUrl: assertLoopbackCdpUrl(opts.cdpUrl ?? DEFAULT_CDP_URL) };
	}
}

export async function importExistingBrowserCookies(opts = {}) {
	const linked = await connectExistingBossBrowser({ ...opts, requirePage: false });
	if (!linked.loggedIn) throw new BrowserSessionError("NOT_LOGGED_IN", "Chrome 里的 Boss 还没有登录");
	const cookies = await linked.context.cookies(SITE);
	return { cookie: effectiveCookieHeader(cookies).header, cookies, page: linked.page, context: linked.context };
}

export function resetBrowserConnectionForTests() { cached = null; }
