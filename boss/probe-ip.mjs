/**
 * 量一件事：**Node 和浏览器是不是从同一个 IP 出去？**
 *
 * 为什么怀疑它：`fetch` 不会自动走系统代理，而 Playwright 是被显式配上代理的。
 * 于是这个项目里的两条链路可能来自两个不同的 IP：
 *
 *   登录 / 过验证  →  无头浏览器（走代理）    IP = 代理出口
 *   抓岗位 / 打招呼 →  Node fetch（直连）      IP = 本机真实 IP
 *
 * 同一个会话在短时间内连着两个 IP 出现，是"环境存在异常"最经典的触发条件。
 * 而且它能解释一个反直觉的现象：**换代理节点没用** —— 因为 Node 那条路根本没走代理，
 * 换节点只换了浏览器那一半。
 *
 *   node boss/probe-ip.mjs
 */
import { SITE, egressIp, loadSession, openSession, systemProxy } from "./lib.mjs";

console.log(`系统代理: ${systemProxy() ?? "（没配）"}\n`);

console.log("① Node 直连出去的 IP（fetch 不认系统代理，所以这是**本机真实 IP**）");
let nodeIp = null;
try {
	nodeIp = await egressIp(loadSession() ?? { cookie: "", bst: "" });
	console.log(`   ${nodeIp ?? "读不到"}`);
} catch (err) {
	console.log(`   失败: ${String(err.message).split("\n")[0]}`);
}

console.log("\n② 无头浏览器出去（走代理）的 IP");
const { ctx } = await openSession({ headless: true });
let browserIp = null;
try {
	for (const p of ctx.pages()) await p.close().catch(() => {});
	const page = await ctx.newPage();
	await page.goto(`${SITE}/wapi/zpgeek/common/data/header.json`, { waitUntil: "domcontentloaded", timeout: 45000 });
	browserIp = await page.evaluate(async () => {
		const r = await fetch("/wapi/zpgeek/common/data/header.json?_=" + Date.now(), { credentials: "include" });
		const j = await r.json().catch(() => null);
		const html = typeof j?.zpData === "string" ? j.zpData : "";
		return /clientIP\s*:\s*["']([^"']+)["']/u.exec(html)?.[1] ?? null;
	});
	console.log(`   ${browserIp ?? "读不到"}`);
} catch (err) {
	console.log(`   失败: ${String(err.message).split("\n")[0]}`);
} finally {
	await ctx.close();
}

console.log("\n── 结论 ──");
if (nodeIp === null || browserIp === null) {
	console.log("  有一边读不到，量不出来。");
} else if (nodeIp === browserIp) {
	console.log(`  两边都是 ${nodeIp} —— IP 是一致的，那 37 就不是"IP 跳"引起的。`);
	console.log("  下一步应该是过 verify.html 墙（npm run verify）。");
} else {
	console.log(`  ✗ 不一致：`);
	console.log(`      Node      → ${nodeIp}`);
	console.log(`      浏览器     → ${browserIp}`);
	console.log(`  同一个会话连着两个 IP，这**足以**触发"您的环境存在异常"。`);
	console.log(`  而且这就是"换节点也没用"的原因：换节点只换了浏览器那边，Node 一直直连。`);
	console.log(`\n  两个修法（选一个，让两边出口一致）：`);
	console.log(`    A. 让 Node 也走代理： set NODE_USE_ENV_PROXY=1  +  set HTTPS_PROXY=${systemProxy() ?? "http://127.0.0.1:7897"}`);
	console.log(`       然后重新起 dsh web（环境变量要在启动前设好）。`);
	console.log(`    B. 让浏览器也直连： npm run verify -- --direct`);
}
