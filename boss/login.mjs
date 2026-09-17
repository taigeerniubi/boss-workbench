/**
 * 登录：一次扫码，之后全部走 HTTP。
 *
 * 流程照 mcp-boss-zp 的契约实现（不调它的服务、不依赖它的代码）：
 *   1. POST /wapi/zppassport/captcha/randkey                     → qrId
 *   2. GET  /wapi/zpweixin/qrcode/getqrcode?content=<qrId>       → 二维码 PNG
 *   3. GET  /wapi/zppassport/qrcode/scan?uuid=<qrId>             → 长轮询，等你扫码
 *   4. GET  /wapi/zppassport/qrcode/scanLogin?qrId=&status=1     → 长轮询，等手机确认
 *   5. GET  /wapi/zppassport/qrcode/dispatcher?qrId=&pk=header-login&fp=<本地生成>
 *                                                                → Set-Cookie：登录凭证
 *   6. 浏览器（整条链上唯一用到的地方）：带着登录 cookie 打开 security-check 页，
 *      Boss 自己的 JS 会把 __zp_stoken__ 写进 cookie，读回来即可。
 *
 * **人在场的唯一动作就是扫码 + 手机确认**，没有别的。安全验证是自动完成的 ——
 * 我一开始以为要人工过滑块，那是在"未登录"状态下撞的另一道墙。
 *
 * 用法： node boss/login.mjs
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	RUNS_DIR, completeSecurityCheck, ensureDirs, generateFp, httpApi,
	isFlagged, loadSession, loginStateHttp, refreshCities, saveSession, writeJson,
} from "./lib.mjs";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 累积响应里的 Set-Cookie（Node 的 getSetCookie 是解析它的正确入口）。 */
function absorb(session, res) {
	const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
	const pairs = [];
	for (const raw of list) {
		const first = raw.split(";")[0].trim();
		if (first.includes("=")) pairs.push(first);
	}
	if (pairs.length === 0) return {};
	const current = new Map(
		session.cookie
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
		const name = pair.slice(0, i);
		const value = pair.slice(i + 1);
		current.set(name, value);
		changed[name] = value;
	}
	session.cookie = [...current].map(([k, v]) => `${k}=${v}`).join("; ");
	return changed;
}

/** 长轮询一个端点，直到 predicate 为真。 */
async function poll(session, path, params, predicate, { label, everyMs = 1200, maxMs = 180000 }) {
	const started = Date.now();
	let round = 0;
	while (Date.now() - started < maxMs) {
		round++;
		const r = await httpApi(path, params, session);
		absorb(session, r);
		if (isFlagged(r.json)) return { ok: false, reason: "flagged", round };
		if (predicate(r)) return { ok: true, round, response: r };
		if (round % 5 === 0) console.log(`  … ${label}（${Math.round((Date.now() - started) / 1000)}s）`);
		await sleep(everyMs);
	}
	return { ok: false, reason: "timeout", round };
}

ensureDirs();

console.log("Boss 登录（扫码一次，之后纯 HTTP）\n");
const session = { cookie: "", bst: "" };

// 已有的会话还能用就直接复用，不折腾你重新扫
const existing = loadSession();
if (existing !== null) {
	const state = await loginStateHttp(existing);
	if (state.flagged) {
		console.log("✗ 当前 IP 被风控（code 35）。先让 IP 冷却，别继续。");
		rl.close();
		process.exit(4);
	}
	if (state.loggedIn) {
		console.log("✓ 已有会话仍然有效，无需重新登录（data/session.json）");
		const cities = await refreshCities(existing);
		console.log(cities.ok ? `  城市表已刷新：${cities.count} 个` : `  城市表没刷新（${cities.reason}）`);
		rl.close();
		process.exit(0);
	}
	console.log("已有会话已失效，走重新登录。\n");
}

// ── 1. randkey ─────────────────────────────────────────────────────────────
console.log("① 取登录会话");
const rand = await httpApi("/wapi/zppassport/captcha/randkey", {}, session, { method: "POST" });
if (isFlagged(rand.json)) {
	console.log("  ✗ 风控 code 35：IP 异常。停手，等冷却或换网络出口。");
	rl.close();
	process.exit(4);
}
absorb(session, rand);
const qrId = rand.json?.zpData?.qrId;
if (qrId === undefined) {
	console.log(`  ✗ 没拿到 qrId。响应：${rand.text.slice(0, 200)}`);
	rl.close();
	process.exit(1);
}
console.log(`  ✓ qrId = ${qrId}`);

// ── 2. 二维码 ──────────────────────────────────────────────────────────────
console.log("\n② 取二维码");
const qrRes = await fetch(`https://www.zhipin.com/wapi/zpweixin/qrcode/getqrcode?content=${encodeURIComponent(qrId)}`, {
	headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.zhipin.com/web/user/?ka=header-login", Cookie: session.cookie },
});
const qrBytes = Buffer.from(await qrRes.arrayBuffer());
const qrPath = join(RUNS_DIR, "qrcode.png");
writeFileSync(qrPath, qrBytes);
console.log(`  ✓ 已存到 ${qrPath}（${qrBytes.length} 字节）`);
console.log(`    另外这个链接也能看：https://www.zhipin.com/wapi/zpweixin/qrcode/getqrcode?content=${qrId}`);

// ── 3 + 4. 扫码与确认（长轮询）─────────────────────────────────────────────
console.log("\n③ 等你用 Boss 直聘 APP 扫码");
const scanned = await poll(session, "/wapi/zppassport/qrcode/scan", { uuid: qrId }, (r) => r.json?.scaned === true, { label: "等待扫码" });
if (!scanned.ok) {
	console.log(`  ✗ ${scanned.reason === "flagged" ? "撞到风控 code 35，停。" : "等扫码超时。"}`);
	rl.close();
	process.exit(scanned.reason === "flagged" ? 4 : 2);
}
console.log("  ✓ 已扫码");

console.log("\n④ 等你在手机上点「确认登录」");
const confirmed = await poll(session, "/wapi/zppassport/qrcode/scanLogin", { qrId, status: 1 }, (r) => r.json?.login === true || r.json?.code === 0, { label: "等待确认" });
if (!confirmed.ok) {
	console.log(`  ✗ ${confirmed.reason === "flagged" ? "撞到风控 code 35，停。" : "等确认超时。"}`);
	rl.close();
	process.exit(confirmed.reason === "flagged" ? 4 : 2);
}
console.log("  ✓ 已确认");

// ── 5. dispatcher：拿登录凭证 ──────────────────────────────────────────────
console.log("\n⑤ 换取登录凭证");
const fp = generateFp();
console.log(`  本地生成的 fp: ${fp.slice(0, 28)}…（每次不同）`);
const disp = await httpApi("/wapi/zppassport/qrcode/dispatcher", { qrId, pk: "header-login", fp }, session);
if (isFlagged(disp.json)) {
	console.log("  ✗ 风控 code 35。");
	rl.close();
	process.exit(4);
}
const granted = absorb(session, disp);
const names = Object.keys(granted);
console.log(`  Set-Cookie: ${names.length === 0 ? "（没有！）" : names.join(", ")}`);
if (names.length === 0) {
	console.log("\n  ✗ dispatcher 没下发 cookie。最可能的原因就是 fp 的两个常量失效了 ——");
	console.log("    参考项目自己的 login_verifier.py 里也写着这两个值是文档里的示例值、");
	console.log("    \"在实际场景中需要从页面 JS 动态获取，否则此步骤可能会失败\"。");
	console.log("    要修的话：用有头浏览器打开登录页，从 JS 里抓这两个值，替换 boss/lib.mjs 的");
	console.log("    FP_PLAINTEXT / FP_KEY_B64。原始响应已存 runs/login-debug.json 以便比对。");
	writeJson(join(RUNS_DIR, "login-debug.json"), { at: new Date().toISOString(), status: disp.status, headers: [...disp.headers.entries()], body: disp.text.slice(0, 2000) });
	rl.close();
	process.exit(3);
}
session.bst = granted.bst ?? "";
saveSession({ cookie: session.cookie, bst: session.bst, stoken: null, step: "granted" });
console.log(`  bst: ${session.bst === "" ? "（无）" : session.bst.slice(0, 12) + "…"}`);

// ── 6. 安全验证：唯一用到浏览器的一步 ──────────────────────────────────────
console.log("\n⑥ 过安全验证（浏览器只在这一步出场）");
let finalCookie = session.cookie;
try {
	const sec = await completeSecurityCheck(session.cookie, { log: (m) => console.log(m) });
	if (sec.stoken !== null) {
		finalCookie = sec.cookie;
		console.log("  ✓ __zp_stoken__ 已拿到，之后全走 HTTP");
	} else {
		console.log("  ⚠️ 没拿到 __zp_stoken__，先按没有它继续试（有些接口可能仍可用）");
	}
} catch (err) {
	console.log(`  ⚠️ 安全验证这一步出错：${String(err.message).split("\n")[0]}`);
}
saveSession({ cookie: finalCookie, bst: session.bst, stoken: finalCookie.includes("__zp_stoken__") ? "present" : null, step: "logged-in" });

// ── 收尾：验一下登录态 + 缓存城市表 ────────────────────────────────────────
const after = await loginStateHttp({ cookie: finalCookie, bst: session.bst });
console.log(`\n结果`);
console.log(`  登录态 : ${after.loggedIn ? "✓ 已登录" : "✗ 仍未登录"}`);
console.log(`  风控   : ${after.flagged ? "✗ code 35" : "✓ 正常"}`);
console.log(`  会话   : data/session.json（cookie ${finalCookie.length} 字节）`);
if (after.loggedIn) {
	const cities = await refreshCities({ cookie: finalCookie, bst: session.bst });
	console.log(cities.ok ? `  城市表 : ✓ 缓存了 ${cities.count} 个 → data/cities.json` : `  城市表 : ✗ ${cities.reason}`);
	console.log(`\n下一步：node boss/scrape.mjs --city 北京 --query "后端开发" --yes`);
} else {
	console.log(`\n没登录成功就先别抓取。可对照 runs/login-debug.json 排查。`);
}

rl.close();
