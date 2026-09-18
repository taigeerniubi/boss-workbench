/**
 * 复用用户已经打开的 Chrome/BOSS 会话。
 *
 * 这套实现只搬运行为策略：CDP 连接现有浏览器、复用现有 context/page、在页面里
 * fetch。它不引用 boss-agent-cli 的包、文件或运行时。
 */
import { loadChromium } from "./playwright.mjs";
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
 * 连接现有 Chrome。不会 launch，不会创建 context，也不会关闭用户的浏览器。
 * regular 模式还要求已经存在 Boss 页面；找不到就 fail closed。
 */
export async function connectExistingBossBrowser({ cdpUrl = DEFAULT_CDP_URL, chromium: suppliedChromium = null, requirePage = true } = {}) {
	const safeUrl = assertLoopbackCdpUrl(cdpUrl);
	if (cached?.browser?.isConnected?.()) {
		const picked = await selectExistingBossSession(cached.browser.contexts());
		if (picked !== null && (!requirePage || picked.page !== null)) return { ...picked, browser: cached.browser, cdpUrl: safeUrl };
	}
	const chromium = suppliedChromium ?? await loadChromium();
	let browser;
	try {
		browser = await chromium.connectOverCDP(safeUrl, { timeout: 5000 });
	} catch (err) {
		throw new BrowserSessionError(
			"CDP_UNAVAILABLE",
			`没有找到可复用的 Chrome 调试会话（${safeUrl}）。请先用 --remote-debugging-port=9222 启动 Chrome，并在里面登录 Boss。${String(err?.message ?? "").includes("ECONNREFUSED") ? "" : ""}`,
		);
	}
	cached = { browser, cdpUrl: safeUrl };
	browser.on?.("disconnected", () => { if (cached?.browser === browser) cached = null; });
	const picked = await selectExistingBossSession(browser.contexts());
	if (picked === null) throw new BrowserSessionError("BROWSER_SESSION_NOT_FOUND", "Chrome 里没有可复用的 Boss 页面或登录态");
	if (requirePage && picked.page === null) throw new BrowserSessionError("BOSS_PAGE_NOT_FOUND", "Chrome 已登录 Boss，但没有打开 Boss 页面；请先打开职位页再重试");
	return { ...picked, browser, cdpUrl: safeUrl };
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
