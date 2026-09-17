/**
 * 扫码登录的**状态机**，宿主路由与命令行共用一份实现。
 *
 * 为什么要有这个模块：登录不是一次请求，是五步 + 一个浏览器步骤，
 * 而 UI 需要"扫到没有"的中间态。把它做成有状态的流程，UI 每 2 秒问一次就行。
 *
 *   ① POST /wapi/zppassport/captcha/randkey                   → qrId
 *   ② GET  /wapi/zpweixin/qrcode/getqrcode?content=<qrId>     → 二维码 PNG
 *   ③ GET  /wapi/zppassport/qrcode/scan?uuid=<qrId>           → scaned?
 *   ④ GET  /wapi/zppassport/qrcode/scanLogin?qrId=&status=1    → code 0?
 *   ⑤ GET  /wapi/zppassport/qrcode/dispatcher?…&fp=<本地生成>  → Set-Cookie
 *   ⑥ 无头浏览器打开 security-check 页 → __zp_stoken__ 自动写入
 *
 * phase: idle → waiting-scan → waiting-confirm → finalizing → logged-in
 *        另有 flagged（code 35）/ expired / failed 三种终止态。
 */
import { completeSecurityCheck, generateFp, httpApi, isFlagged, loginStateHttp, saveSession } from "./lib.mjs";

const EXPIRE_MS = 3 * 60 * 1000;
const FINALIZE_TIMEOUT_MS = 60 * 1000;

/** 当前这一次登录尝试。同一时间只允许一个 —— 二维码是单例的。 */
let flow = { phase: "idle", qrId: null, cookie: "", bst: "", startedAt: 0, error: null, finalizing: false };

/** 登录态检查的短缓存，避免页面每次挂载都打一次 Boss。 */
let stateCache = { at: 0, value: null };
const STATE_TTL_MS = 30 * 1000;

const setPhase = (phase, extra = {}) => {
	flow = { ...flow, phase, ...extra };
	return snapshot();
};
const snapshot = () => ({
	phase: flow.phase,
	qrId: flow.qrId,
	startedAt: flow.startedAt === 0 ? null : new Date(flow.startedAt).toISOString(),
	error: flow.error,
});

/** 把响应里的 Set-Cookie 合并进这次流程的 cookie 串。 */
function absorb(res) {
	const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
	const pairs = [];
	for (const raw of list) {
		const first = raw.split(";")[0].trim();
		if (first.includes("=")) pairs.push(first);
	}
	if (pairs.length === 0) return {};
	const jar = new Map(
		flow.cookie
			.split("; ")
			.filter((p) => p.includes("="))
			.map((p) => {
				const i = p.indexOf("=");
				return [p.slice(0, i), p.slice(i + 1)];
			}),
	);
	const changed = {};
	for (const pair of pairs) {
		const i = pair.indexOf("=");
		jar.set(pair.slice(0, i), pair.slice(i + 1));
		changed[pair.slice(0, i)] = pair.slice(i + 1);
	}
	flow.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
	return changed;
}

/** ① + ②：开一次登录会话并取二维码（返回可直接塞进 <img src> 的 data URL）。 */
export async function startLogin({ force = false } = {}) {
	if (!force && flow.phase !== "idle" && flow.phase !== "expired" && flow.phase !== "failed" && Date.now() - flow.startedAt < EXPIRE_MS) {
		return { ok: true, resumed: true, ...snapshot() };
	}
	flow = { phase: "idle", qrId: null, cookie: "", bst: "", startedAt: Date.now(), error: null, finalizing: false };

	const rand = await httpApi("/wapi/zppassport/captcha/randkey", {}, { cookie: "", bst: "" }, { method: "POST" });
	if (isFlagged(rand.json)) return { ok: false, ...setPhase("flagged", { error: `风控 code 35：${rand.json?.message ?? ""}` }) };
	absorb(rand);
	const qrId = rand.json?.zpData?.qrId;
	if (qrId === undefined) return { ok: false, ...setPhase("failed", { error: `拿不到 qrId：${rand.text?.slice(0, 120)}` }) };

	const res = await fetch(`https://www.zhipin.com/wapi/zpweixin/qrcode/getqrcode?content=${encodeURIComponent(qrId)}`, {
		headers: { "user-agent": "Mozilla/5.0", referer: "https://www.zhipin.com/web/user/?ka=header-login", cookie: flow.cookie },
	});
	const bytes = Buffer.from(await res.arrayBuffer());
	if (bytes.length === 0) return { ok: false, ...setPhase("failed", { error: `二维码为空（HTTP ${res.status}）` }) };
	// 按魔数判断真实类型：Boss 这个接口回的是 JPEG，虽然习惯上叫 "qrcode"
	const mime = bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "application/octet-stream";

	setPhase("waiting-scan", { qrId, startedAt: Date.now() });
	return { ok: true, resumed: false, qr: `data:${mime};base64,${bytes.toString("base64")}`, ...snapshot() };
}

/** ⑤ + ⑥：换了登录凭证之后，用浏览器把 __zp_stoken__ 拿回来。 */
async function finalize() {
	flow.finalizing = true;
	flow.phase = "finalizing";
	try {
		const fp = generateFp();
		const disp = await httpApi("/wapi/zppassport/qrcode/dispatcher", { qrId: flow.qrId, pk: "header-login", fp }, { cookie: flow.cookie, bst: "" });
		if (isFlagged(disp.json)) return setPhase("flagged", { error: `风控 code 35：${disp.json?.message ?? ""}` });
		const granted = absorb(disp);
		if (Object.keys(granted).length === 0) {
			// 参考项目自己都写了：fp 的两个常量是文档示例值，可能失效
			return setPhase("failed", { error: "dispatcher 没下发 cookie —— 大概率 fp 的两个常量失效了（见 DESIGN §9.2）" });
		}
		flow.bst = granted.bst ?? "";

		const sec = await completeSecurityCheck(flow.cookie, { log: (line) => console.log(line) });
		const finalCookie = sec.stoken === null ? flow.cookie : sec.cookie;
		saveSession({ cookie: finalCookie, bst: flow.bst, stoken: sec.stoken === null ? null : "present", step: sec.verify?.ok === true ? "logged-in" : "unverified" });
		// 只有 Boss 自己说 code 0 才算登录成功。以前这里是无条件 logged-in，
		// 于是 UI 会显示"登录成功"，然后第一个请求就回 code 7 —— 现在如实回报。
		if (sec.verify?.ok !== true) {
			stateCache = { at: 0, value: null };
			return setPhase("uncertain", {
				error: `拿到 cookie 了，但 Boss 说还没登录（code=${sec.verify?.code} ${sec.verify?.message ?? ""}）。多半是这次二维码确认没走完 —— 再扫一次。`,
			});
		}
		stateCache = { at: Date.now(), value: { loggedIn: true, flagged: false, message: "just logged in" } };
		return setPhase("logged-in", { account: sec.verify.user ?? null });
	} catch (err) {
		return setPhase("failed", { error: `验证步骤出错：${String(err.message).split("\n")[0]}` });
	} finally {
		flow.finalizing = false;
	}
}

/** UI 轮询这个。每次调用只推进一步，绝不阻塞。 */
export async function pollLogin() {
	if (flow.qrId === null) return snapshot();
	if (flow.finalizing) return snapshot(); // ⑥ 正在跑（要开浏览器，几秒），别并发触发
	// 过期只对"还没扫"有意义：一旦扫上了，等你按确认是人的事，不能因为几分钟就作废
	if (flow.phase === "waiting-scan" && Date.now() - flow.startedAt > EXPIRE_MS) {
		return setPhase("expired", { error: "二维码已过期，请重新获取" });
	}

	const sess = { cookie: flow.cookie, bst: flow.bst };
	if (flow.phase === "waiting-scan") {
		const r = await httpApi("/wapi/zppassport/qrcode/scan", { uuid: flow.qrId }, sess);
		absorb(r);
		if (isFlagged(r.json)) return setPhase("flagged", { error: `风控 code 35：${r.json?.message ?? ""}` });
		if (r.json?.scaned === true) return setPhase("waiting-confirm");
		return snapshot();
	}
	if (flow.phase === "waiting-confirm") {
		const r = await httpApi("/wapi/zppassport/qrcode/scanLogin", { qrId: flow.qrId, status: 1 }, sess);
		absorb(r);
		if (isFlagged(r.json)) return setPhase("flagged", { error: `风控 code 35：${r.json?.message ?? ""}` });
		// 实测这个接口回的是 {"scaned":true,"newScaned":true,"login":true} —— **没有 code 字段**。
		// 所以判据是 login === true（code === 0 只是留着兼容别的返回形态）。
		if (r.json?.login === true || r.json?.code === 0) return finalize();
		return snapshot();
	}
	if (flow.phase === "finalizing") return snapshot();
	return snapshot();
}

/** 当前登录态。带 30 秒缓存，页面挂载时问一次不会打爆 Boss。 */
export async function loginState({ force = false } = {}) {
	const session = (await import("./lib.mjs")).loadSession();
	if (session === null) return { loggedIn: false, present: false };
	if (!force && stateCache.value !== null && Date.now() - stateCache.at < STATE_TTL_MS) return { ...stateCache.value, present: true, cached: true };
	const state = await loginStateHttp(session);
	const value = { loggedIn: state.loggedIn, flagged: state.flagged, message: state.message };
	stateCache = { at: Date.now(), value };
	return { ...value, present: true };
}

export const currentFlow = () => snapshot();
