/**
 * 把你**已经确认过**的那次登录走完。
 *
 * 为什么需要这个脚本：宿主那份代码在 waiting-confirm 上判错了字段
 * （`scanLogin` 回的是 `{"login":true}`，没有 code），所以你在手机上确认了、
 * 流程却没往下走。这个脚本直接拿那个 qrId 把最后两步补完：
 *
 *   ⑤ dispatcher（+ 本地生成的 fp）→ Set-Cookie（登录凭证 + bst）
 *   ⑥ 无头浏览器打开 security-check 页 → __zp_stoken__ 自动写入
 *   ⑦ 落盘 data/session.json
 *
 * 顺带把这两步在真实环境里验证一遍 —— 这是整条链上唯一还没跑通过的部分。
 *
 * 用法： node boss/login-finish-once.mjs [qrId]
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { completeSecurityCheck, generateFp, httpApi, isFlagged, loadSession, loginStateHttp, saveSession, systemProxy } from "./lib.mjs";

const HOST = "127.0.0.1:3080";
const log = (m) => console.log(m);

// 从宿主的流程里取 qrId（也可以命令行给）
let qrId = process.argv[2] ?? null;
if (qrId === null) {
	const cred = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, "utf8");
	const secret = Buffer.from(cred.match(/secret:\s*([A-Za-z0-9_-]+)/)[1].replaceAll("-", "+").replaceAll("_", "/"), "base64");
	const b64u = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
	const issuedAt = Date.now();
	const expiresAt = issuedAt + 30 * 86400 * 1000;
	const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority: HOST, issuedAt, expiresAt }), "utf8"));
	const cookie = `dsh-auth-${b64u(createHash("sha256").update(HOST).digest())}=v1.${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;
	const st = await fetch(`http://${HOST}/boss/login/status`, { headers: { cookie } }).then((r) => r.json()).catch(() => null);
	qrId = st?.qrId ?? null;
	console.log(`宿主状态: phase=${st?.phase ?? "?"}  qrId=${qrId ?? "(空)"}`);
}
if (qrId === null || qrId === undefined) {
	console.log("✗ 没有 qrId。先在 UI 里重新取一次二维码（扫码前）再跑本脚本，或直接传 qrId。");
	process.exit(1);
}

console.log(`\n代理: ${systemProxy() ?? "（直连）"}`);
console.log(`qrId: ${qrId}\n`);

// ── ⑤ dispatcher ──────────────────────────────────────────────────────────
console.log("⑤ dispatcher（换登录凭证）");
const fp = generateFp();
console.log(`   本地生成 fp: ${fp.slice(0, 24)}…`);
const disp = await httpApi("/wapi/zppassport/qrcode/dispatcher", { qrId, pk: "header-login", fp }, { cookie: "", bst: "" });
console.log(`   HTTP ${disp.status}  body: ${disp.text?.slice(0, 160) ?? ""}`);
if (isFlagged(disp.json)) {
	console.log(`   ✗ 风控 code 35 —— 停。`);
	process.exit(2);
}
const setCookies = typeof disp.headers.getSetCookie === "function" ? disp.headers.getSetCookie() : [];
const jar = new Map();
for (const raw of setCookies) {
	const first = raw.split(";")[0].trim();
	if (!first.includes("=")) continue;
	const i = first.indexOf("=");
	jar.set(first.slice(0, i), first.slice(i + 1));
}
console.log(`   Set-Cookie: ${jar.size === 0 ? "（没有！fp 常量可能失效）" : [...jar.keys()].join(", ")}`);
if (jar.size === 0) {
	console.log("   ✗ dispatcher 没下发 cookie。参考项目自己也标注过：fp 的两个常量是文档示例值，会失效。");
	process.exit(3);
}
const cookieStr = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const bst = jar.get("bst") ?? "";
console.log(`   bst: ${bst === "" ? "（无）" : bst.slice(0, 12) + "…"}`);

// ── ⑥ 安全验证 ────────────────────────────────────────────────────────────
console.log("\n⑥ 安全验证（唯一用到浏览器的一步，走代理）");
let finalCookie = cookieStr;
let stoken = null;
try {
	const sec = await completeSecurityCheck(cookieStr, { log: (m) => console.log("   " + m) });
	stoken = sec.stoken;
	if (stoken !== null) finalCookie = sec.cookie;
} catch (err) {
	console.log(`   ⚠ 出错: ${String(err.message).split("\n")[0]}`);
}

// ── ⑦ 落盘 + 验证 ─────────────────────────────────────────────────────────
console.log("\n⑦ 落盘并验证");
saveSession({ cookie: finalCookie, bst, stoken: stoken === null ? null : "present", step: "logged-in" });
console.log(`   data/session.json 已写（cookie ${finalCookie.length} 字节，stoken ${stoken === null ? "无" : "有"}）`);
const state = await loginStateHttp({ cookie: finalCookie, bst });
console.log(`   登录态: ${state.loggedIn ? "✓ 已登录" : "✗ 仍未登录"}   风控: ${state.flagged ? "✗ code 35" : "✓ 正常"}`);
if (!state.loggedIn) {
	console.log(`\n   没登录成功。既有 session 快照：${JSON.stringify(loadSession())?.slice(0, 120)}`);
	console.log(`   cookie 里的字段: ${[...jar.keys()].join(", ")}`);
	process.exit(4);
}
console.log("\n✓ 完成。接下来： node boss/scrape.mjs --city 北京 --query \"后端开发\" --yes");
