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
	resetAutoLaunchForTests,
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

/**
 * 导航护栏 + 导航日志。
 *
 * 为什么需要：用户报过一次"页面一直刷新"。界面上看到的现象是 Boss 页不停重载，
 * 而插件里能触发导航的只有两处（这里和 verifyOnce）—— 只要有一处在循环里被反复
 * 打到，用户看到的就是刷新风暴。所以：
 *   1. **同一页同一目标地址，60 秒内只导航一次**（除非显式 force）；
 *   2. 每次导航都记一条日志，`/boss/login/state` 会把它带出来 ——
 *      如果页面还在刷新而这份日志是空的，那刷新就不是插件干的（比如站内自己重载）。
 *
 * 这是"先保证不是自己干的，再看是谁干的"，而不是靠猜。
 */
const NAV_COOLDOWN_MS = 60 * 1000;
const navLog = [];
const lastNav = new Map();
const noteNav = (entry) => {
	navLog.push({ at: new Date().toISOString(), ...entry });
	if (navLog.length > 30) navLog.shift();
};
export const readNavLog = () => navLog.slice();
export function resetNavLogForTests() {
	navLog.length = 0;
	lastNav.clear();
}

/**
 * 把某个 page 导航到目标地址，但**同一目标在冷却期内只做一次**。
 *
 * `alreadyThere(current)` 决定"当前这个地址算不算已经到位"：
 *   - 已经在目标路径上 → 直接跳过（最常见）；
 *   - 已经在这个站点的**合适页面**上（比如用户在职位页）→ 也不动它，
 *     免得把用户正在看的页面顶掉。
 * 只有真的不在合适页面时，才导航一次；同一目标 60 秒内不重复。
 */
export async function navigateOnce(page, target, { force = false, timeout = 45000, alreadyThere = null } = {}) {
	const current = String(page.url?.() ?? "");
	const inPlace = current.startsWith(target) || (typeof alreadyThere === "function" && alreadyThere(current));
	if (inPlace) {
		noteNav({ action: "skip", target, current, why: current.startsWith(target) ? "已经在目标地址" : "已经在合适页面" });
		return { navigated: false, current, skipped: true };
	}
	const previous = lastNav.get(target) ?? 0;
	if (!force && Date.now() - previous < NAV_COOLDOWN_MS) {
		noteNav({ action: "throttled", target, current, msSince: Date.now() - previous });
		return { navigated: false, current, throttled: true };
	}
	lastNav.set(target, Date.now());
	noteNav({ action: "goto", target, current });
	try {
		await page.goto(target, { waitUntil: "domcontentloaded", timeout });
	} catch (err) {
		// 导航失败不该把整条登录流程判死：页面可能只是慢，或者用户手快点了别处。
		// 记下来，让上层能看见原因，但调用方自己决定要不要降级。
		noteNav({ action: "goto-failed", target, error: String(err?.message ?? err) });
		return { navigated: false, current, error: String(err?.message ?? err) };
	}
	return { navigated: true, current: String(page.url?.() ?? "") };
}

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
			await navigateOnce(page, `${SITE}/web/geek/jobs`);
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

/**
 * 连接现有 Chrome。连不上就**先由插件自己把可调试的 Chrome 拉起来**，
 * 再用那个窗口去登录/复用 —— 用户不该为了用插件去记 `--remote-debugging-port`。
 *
 * `autoLaunch` 只在"用户刚进工作台 / 点了重新连接"这类入口为 true；
 * 抓取和读会话不重复触发（见 browser-channel 里那个每进程只试一次的闸门）。
 *
 * 窗口可见性：先按默认（隐藏）连；发现没登录、需要扫码时，再换成 `visible: true`
 * 的可见实例。登录完之后那个可见窗口留着不动（用户可能还在看）；关掉后下次抓取会
 * 重新拉一个隐藏实例，登录态在 profile 里，不用再扫。
 */
export async function startLogin({ force = false, autoLaunch = true } = {}) {
	if (!force && ["waiting-browser", "verifying", "logged-in"].includes(flow.phase) && Date.now() - flow.startedAt < EXPIRE_MS) {
		return { ok: true, resumed: true, ...snapshot() };
	}
	flow = { phase: "connecting-browser", startedAt: Date.now(), error: null, detail: "正在连接本机 Chrome（没开调试口的话会自动拉起一个）…", context: null, page: null, ownedPage: false, finalizing: false, account: null };
	let linked;
	try {
		linked = await connectExistingBossBrowser({ requirePage: false, autoLaunch });
	} catch (err) {
		const code = err instanceof BrowserSessionError ? err.code : "CDP_ERROR";
		return { ok: false, ...setPhase("browser-unavailable", { error: String(err?.message ?? err), detail: code }) };
	}
	flow.context = linked.context;
	flow.page = linked.page;
	if (linked.loggedIn) return { ok: true, resumed: false, ...(await verifyOnce()) };
	// 还没登录 → 要扫码 → 必须有看得见的窗口。默认拉起是隐藏模式，这里换成可见实例
	// （无头的先退出再重拉，同一 profile 不能并存两个实例）。已登录的路径用不到这一步。
	try {
		linked = await connectExistingBossBrowser({ requirePage: false, autoLaunch: true, visible: true });
		flow.context = linked.context;
		flow.page = linked.page;
	} catch (err) {
		const code = err instanceof BrowserSessionError ? err.code : "CDP_ERROR";
		return { ok: false, ...setPhase("browser-unavailable", { error: String(err?.message ?? err), detail: code }) };
	}
	if (linked.loggedIn) return { ok: true, resumed: false, ...(await verifyOnce()) };
	try {
		if (flow.page === null || flow.page.isClosed?.()) {
			flow.page = await linked.context.newPage();
			flow.ownedPage = true;
		}
		// 用带冷却的导航：已经在合适页面上就不碰它（用户可能正看着那一页），
		// 同一目标 60 秒内也不重复导航 —— 页面刷新风暴就是这么来的。
		const nav = await navigateOnce(flow.page, LOGIN_URL, {
			// 已经登录着、或在职位/聊天页上，就算到位，不要去顶掉用户的页面
			alreadyThere: (url) => url.startsWith(SITE) && /\/web\/geek\//u.test(url),
		});
		return { ok: true, resumed: false, ...setPhase("waiting-browser", { detail: nav.navigated ? "已在浏览器里打开 Boss 登录页，请扫码并完成手机验证" : "请在浏览器里完成 Boss 登录", nav }) };
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

/**
 * 状态检查。
 *
 * `autoLaunch: true` 是**"进工作台就帮你把 Chrome 准备好"**的入口：
 * 9222 没在监听时插件自己拉一个可调试的 Chrome（用插件自己的 profile，
 * 不碰用户日常那个窗口），然后报告登录态。整个过程用户不用敲任何命令。
 *
 * 只在没有缓存时才会去连，所以不会每次渲染都 spawn 浏览器。
 */
export async function loginState({ force = false, autoLaunch = true } = {}) {
	if (!force && stateCache.value !== null && Date.now() - stateCache.at < STATE_TTL_MS) return { ...stateCache.value, present: true, cached: true };
	const status = await existingBrowserStatus({ autoLaunch });
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
	// 退出登录之后允许下一次再自动拉一次浏览器（用户可能把窗口关了）
	resetAutoLaunchForTests();
	return { ok: true, clearedCookies: 0, browserCookiesUntouched: true, at: new Date().toISOString() };
}

export const currentFlow = () => snapshot();
