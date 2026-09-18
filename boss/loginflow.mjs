/**
 * 登录绑定状态机：连接用户已经启动的 Chrome 调试会话，复用真实浏览器上下文。
 *
 * 不再由 Node 申请二维码、伪造 fp 或启动独立无头 profile。用户在真实 Chrome 的
 * Boss 页面里扫码/验证；这里平时只读 cookie，检测到 wt2 后才发一次 userInfo 校验。
 */
import {
	BrowserSessionError,
	browserJson,
	classifyBossResponse,
	connectExistingBossBrowser,
	existingBrowserStatus,
} from "./browser-channel.mjs";
import { SITE, clearSession, effectiveCookieHeader, markCooldown, parseCookieJar, saveSession } from "./lib.mjs";

const LOGIN_URL = `${SITE}/web/user/?ka=header-login`;
const EXPIRE_MS = 10 * 60 * 1000;

let flow = {
	phase: "idle", startedAt: 0, error: null, detail: null,
	context: null, page: null, ownedPage: false, finalizing: false, account: null,
};
let stateCache = { at: 0, value: null };
const STATE_TTL_MS = 15 * 1000;

const snapshot = () => ({
	phase: flow.phase,
	startedAt: flow.startedAt === 0 ? null : new Date(flow.startedAt).toISOString(),
	error: flow.error,
	detail: flow.detail,
	account: flow.account,
});
const setPhase = (phase, extra = {}) => {
	flow = { ...flow, phase, ...extra };
	return snapshot();
};

const riskCooldown = (kind, message) => {
	if (["ip-risk", "account-risk", "environment-risk", "browser-blocked", "rate-limited"].includes(kind)) {
		markCooldown({ kind, message });
	}
};

async function saveLinkedSession(context, verify) {
	const cookies = await context.cookies(SITE);
	const cookie = effectiveCookieHeader(cookies).header;
	const bst = parseCookieJar(cookie).get("bst") ?? "";
	saveSession({ cookie, bst, stoken: parseCookieJar(cookie).has("__zp_stoken__") ? "present" : null, step: "browser-linked", source: "cdp" });
	stateCache = { at: Date.now(), value: { loggedIn: true, flagged: false, code: 0, message: verify?.message ?? "Success", source: "cdp" } };
}

/** 登录完成后只做一次同页校验；任何风控响应都终止，不重试。 */
async function verifyOnce() {
	if (flow.finalizing) return snapshot();
	flow.finalizing = true;
	setPhase("verifying", { detail: "检测到登录凭证，正在用当前 Boss 页面校验一次…", error: null });
	try {
		let page = flow.page;
		if (page === null || page.isClosed?.()) {
			page = await flow.context.newPage();
			flow.page = page;
			flow.ownedPage = true;
			await page.goto(`${SITE}/web/geek/jobs`, { waitUntil: "domcontentloaded", timeout: 45000 });
		}
		const response = await browserJson(page, "/wapi/zpuser/wap/getUserInfo.json", {}, { referer: `${SITE}/web/geek/jobs` });
		const state = classifyBossResponse(response.json, response);
		if (state.kind !== "success") {
			riskCooldown(state.kind, `登录校验终止：${response.json?.message ?? state.kind}`);
			return setPhase(state.kind, { error: response.json?.message ?? `登录校验失败：${state.kind}`, detail: null });
		}
		const user = response.json?.zpData?.userInfo ?? response.json?.zpData ?? {};
		await saveLinkedSession(flow.context, response.json);
		return setPhase("logged-in", { account: user.name ?? user.nickName ?? user.uid ?? null, error: null, detail: "已绑定当前 Chrome 会话" });
	} catch (err) {
		return setPhase("failed", { error: String(err?.message ?? err), detail: null });
	} finally {
		flow.finalizing = false;
	}
}

/** 连接现有 Chrome；没有登录时在该 context 里打开一个可见登录页。 */
export async function startLogin({ force = false } = {}) {
	if (!force && ["waiting-browser", "verifying", "logged-in"].includes(flow.phase) && Date.now() - flow.startedAt < EXPIRE_MS) {
		return { ok: true, resumed: true, ...snapshot() };
	}
	flow = { phase: "connecting-browser", startedAt: Date.now(), error: null, detail: "正在连接本机 Chrome…", context: null, page: null, ownedPage: false, finalizing: false, account: null };
	let linked;
	try {
		linked = await connectExistingBossBrowser({ requirePage: false });
	} catch (err) {
		const code = err instanceof BrowserSessionError ? err.code : "CDP_ERROR";
		return { ok: false, ...setPhase("browser-unavailable", { error: String(err?.message ?? err), detail: code }) };
	}
	flow.context = linked.context;
	flow.page = linked.page;
	if (linked.loggedIn) return { ok: true, resumed: false, ...(await verifyOnce()) };
	try {
		if (flow.page === null || flow.page.isClosed?.()) {
			flow.page = await linked.context.newPage();
			flow.ownedPage = true;
		}
		if (!String(flow.page.url()).startsWith(SITE)) {
			await flow.page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
		}
		return { ok: true, resumed: false, ...setPhase("waiting-browser", { detail: "请在刚打开的 Chrome 标签里扫码并完成手机验证" }) };
	} catch (err) {
		return { ok: false, ...setPhase("failed", { error: `打开 Boss 登录页失败：${String(err?.message ?? err)}`, detail: null }) };
	}
}

/** 轮询只读浏览器 cookie；出现 wt2 后才做一次网络校验。 */
export async function pollLogin() {
	if (flow.phase !== "waiting-browser") return snapshot();
	if (Date.now() - flow.startedAt > EXPIRE_MS) return setPhase("expired", { error: "等待登录超时，请重新连接浏览器", detail: null });
	try {
		const cookies = await flow.context.cookies(SITE);
		const loggedIn = cookies.some((cookie) => cookie.name === "wt2" && String(cookie.value).length > 0);
		if (!loggedIn) return snapshot();
		return verifyOnce();
	} catch (err) {
		return setPhase("failed", { error: `读取 Chrome 登录态失败：${String(err?.message ?? err)}`, detail: null });
	}
}

/** 状态检查只看现有浏览器/cookie，不在页面挂载时额外请求 Boss。 */
export async function loginState({ force = false } = {}) {
	if (!force && stateCache.value !== null && Date.now() - stateCache.at < STATE_TTL_MS) return { ...stateCache.value, present: true, cached: true };
	const status = await existingBrowserStatus();
	const value = status.ok
		? { loggedIn: status.loggedIn && status.hasPage, flagged: false, code: null, message: status.loggedIn ? (status.hasPage ? "Chrome 已登录" : "请在 Chrome 打开 Boss 页面") : "Chrome 中尚未登录", source: "cdp", browser: status }
		: { loggedIn: false, flagged: false, code: status.code, message: status.error, source: "cdp", browser: status };
	stateCache = { at: Date.now(), value };
	return { ...value, present: status.loggedIn };
}

/** 这里只解除插件绑定，不退出用户真实 Chrome 里的 Boss。 */
export async function logout() {
	clearSession();
	flow = { phase: "idle", startedAt: 0, error: null, detail: null, context: null, page: null, ownedPage: false, finalizing: false, account: null };
	stateCache = { at: 0, value: null };
	return { ok: true, clearedCookies: 0, browserCookiesUntouched: true, at: new Date().toISOString() };
}

export const currentFlow = () => snapshot();
