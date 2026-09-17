/**
 * 一条命令把登录做完：出二维码 → 存成 PNG → 轮询 → 完成后落盘。
 *
 * 为什么要有它：宿主的 UI 那份代码要重启 GUI 才生效，而登录本身不需要 UI。
 * 用它出一个二维码给你扫，扫完这条命令自己就结束了，凭证进 data/session.json。
 *
 * 用法： node boss/login-now.mjs
 *       （二维码写到 runs/qrcode-now.png，扫这个图）
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, ensureDirs, loadSession, loginStateHttp, systemProxy } from "./lib.mjs";
import { currentFlow, pollLogin, startLogin } from "./loginflow.mjs";

ensureDirs();
console.log(`代理: ${systemProxy() ?? "（直连）"}`);

const started = await startLogin({ force: true });
if (!started.ok) {
	console.log(`✗ 起不来: ${started.error ?? started.phase}`);
	process.exit(1);
}
const b64 = String(started.qr).split(",")[1] ?? "";
const qrPath = join(RUNS_DIR, "qrcode-now.png");
writeFileSync(qrPath, Buffer.from(b64, "base64"));
console.log(`✓ 二维码已写到 ${qrPath}`);
console.log(`  qrId = ${started.qrId}`);
console.log("  请打开这个 PNG 用 Boss 直聘 APP 扫，并在手机上点确认。\n");

const deadline = Date.now() + 5 * 60 * 1000;
let last = "";
while (Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, 2500));
	const flow = await pollLogin();
	if (flow.phase === "waiting-confirm" && last !== flow.phase) console.log("  → 已扫码，等你在手机上确认…");
	if (flow.phase === "finalizing" && last !== flow.phase) console.log("  → 正在过安全验证（开无头浏览器，几秒）…");
	if (flow.phase === "logged-in") {
		console.log("\n✓ 登录完成");
		const s = loadSession();
		const state = await loginStateHttp(s);
		console.log(`  会话: data/session.json（cookie ${s?.cookie?.length ?? 0} 字节，stoken ${s?.stoken ?? "无"}）`);
		console.log(`  验证: ${state.loggedIn ? "✓ 已登录" : "✗ 仍未登录"}   风控: ${state.flagged ? "✗ code 35" : "✓ 正常"}`);
		console.log(`\n接下来: node boss/scrape.mjs --city 北京 --query "后端开发" --yes`);
		process.exit(state.loggedIn ? 0 : 4);
	}
	if (flow.phase === "flagged" || flow.phase === "expired" || flow.phase === "failed" || flow.phase === "uncertain") {
		console.log(`\n✗ ${flow.phase}: ${flow.error ?? ""}`);
		process.exit(2);
	}
	last = flow.phase;
}
console.log(`\n✗ 超时（${currentFlow().phase}）`);
process.exit(3);
