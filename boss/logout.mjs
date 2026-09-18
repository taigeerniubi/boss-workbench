/**
 * 退出登录（命令行版）。
 *
 * 工作台上也有这个按钮，但宿主半边要重启 GUI 才会加载 `/boss/logout` 路由 ——
 * 这个脚本不依赖 GUI，随时能用。
 *
 * 清三样东西，少一样都会留下"半退出"状态：
 *   ① data/session.json         Node 那边发请求用的 cookie + bst
 *   ② 浏览器 profile 的 cookie   抓取/过验证时用的登录态
 *   ③ 宿主内存里的登录流程状态    否则 /boss/login/start 会把旧流程当"登录成功"复用
 *
 * **不删** browser-profile 目录本身 —— 那里面还有 Boss 认的"这个浏览器过了验证"，
 * 删了下次要重新过 verify 墙。清 cookie 只丢登录态。
 *
 * 简历库（resumes/）和已抓到的岗位（data/jobs.json）**不动**。
 *
 *   node boss/logout.mjs
 */
import { existsSync } from "node:fs";
import { HOME_DIR, SESSION_PATH, clearBrowserCookies, clearSession, loadSession } from "./lib.mjs";

const before = loadSession();
console.log(`数据目录: ${HOME_DIR}`);
console.log(`session.json: ${existsSync(SESSION_PATH) ? `在（cookie ${before?.cookie?.length ?? 0} 字节，保存于 ${before?.savedAt ?? "?"}）` : "本来就没有"}\n`);

if (before === null && !existsSync(SESSION_PATH)) {
	console.log("本来就没登录，不用退。");
}

console.log("① 清 data/session.json");
clearSession();
console.log(`   ${existsSync(SESSION_PATH) ? "已写空" : "已删"}`);

console.log("② 清浏览器 profile 的 cookie（要开一次无头浏览器，几秒）…");
const n = await clearBrowserCookies();
if (n === null) {
	console.log("   ⚠ 没清成（Playwright 不可用或 profile 打不开）。session.json 已经清了，");
	console.log("     所以 Node 那边照样发不出请求；但浏览器里可能还留着登录态。");
} else {
	console.log(`   已清掉 ${n} 个 cookie`);
}

console.log("\n✓ 已退出登录。简历库与已抓到的岗位都没动。");
console.log("  下次要用：工作台里点「抓取岗位」会弹二维码，或者 node boss/login-now.mjs");
if (n === null) process.exit(1);
