/**
 * 修复登录态：**不用重新扫码**。
 *
 * 症状（实测到的）：cookie 里账号信息是对的 —— header.json 能报出 uid、昵称、头像，
 * 但同一份响应里 `isLogin: false`、`identity: -1`，所有 wapi 接口回 code 37「您的环境存在异常」。
 *
 * 病因：`__zp_stoken__` 是**上一次匿名访问**那次安全验证签发的，它绑的是那个会话。
 * 登录换了 wt2/bst 之后，这个旧 stoken 就对不上了 —— 于是"人认得出来，但不是登录态"。
 *
 * 药方：把旧 stoken 丢掉，用现在这份登录 cookie 重过一次安全验证，让 Boss 重签一个。
 *
 *   node boss/repair-session.mjs
 */
import { completeSecurityCheck, loadSession, loginStateHttp, saveSession, systemProxy } from "./lib.mjs";

const session = loadSession();
if (session === null) {
	console.error("✗ 没有 data/session.json —— 这份得先扫码登录，修不了。");
	process.exit(1);
}

console.log(`代理: ${systemProxy() ?? "（直连）"}`);
console.log(`现有 cookie: ${session.cookie.split("; ").map((p) => p.split("=")[0]).join(", ")}\n`);

console.log("① 先看现在是什么状态");
const before = await loginStateHttp(session);
console.log(`   isLogin=${before.loggedIn}  风控=${before.flagged}  ${before.message}`);
if (before.loggedIn) {
	console.log("\n✓ 本来就是登录态，不用修。");
	process.exit(0);
}
if (before.flagged) {
	console.log("\n✗ 撞到 code 35（IP 异常）。别继续，换出口节点再说。");
	process.exit(2);
}

console.log("\n② 丢掉旧 __zp_stoken__，用现有登录 cookie 重过一次安全验证");
let sec;
try {
	sec = await completeSecurityCheck(session.cookie, { dropStoken: true, log: (m) => console.log("   " + m) });
} catch (err) {
	console.log(`   ✗ 出错: ${String(err.message).split("\n")[0]}`);
	process.exit(3);
}

console.log("\n③ 落盘");
saveSession({
	cookie: sec.stoken === null ? session.cookie : sec.cookie,
	bst: session.bst,
	stoken: sec.stoken === null ? null : "present",
	step: sec.verify?.ok === true ? "logged-in" : "unverified",
});
console.log(`   data/session.json 已更新（cookie ${sec.cookie.length} 字节，stoken ${sec.stoken === null ? "无" : sec.stoken.length + " 字节"}）`);

if (sec.verify?.ok === true) {
	// user 是运行时读出来的，写进日志没问题（源码里不出现任何账号字面量）
	console.log(`\n✓ 修好了：getUserInfo code 0${sec.verify.user === null ? "" : "，账号 " + String(sec.verify.user)}`);
	console.log(`  接下来: node boss/scrape.mjs --city 北京 --query "后端开发" --yes`);
	process.exit(0);
}
console.log(`\n✗ 还是不行：code=${sec.verify?.code} ${sec.verify?.message ?? ""}`);
console.log(`  说明问题不在 stoken，得重新扫码登录（node boss/login-now.mjs）。`);
process.exit(4);
