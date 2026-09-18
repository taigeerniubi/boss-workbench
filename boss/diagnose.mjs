/**
 * 一次跑完，回答一个问题：**code 37 到底是我们代码的毛病，还是账号被风控了？**
 *
 * 三个变体，各问一次 `/wapi/zpuser/wap/getUserInfo.json`（code 0 = 真登录态）：
 *
 *   ① Node + 原样的 cookie 串（**带重复名字**）   ← 现在 data/session.json 里就是这种
 *   ② Node + 去重后的 cookie 串
 *   ③ 持久 profile 的浏览器 + 去重后的 cookie 串
 *
 * 怎么读结果：
 *   ①✗ ②✓        → 是重复 cookie 的锅（`.zhipin.com` 和 `www.zhipin.com` 各存一份，
 *                   服务端取到哪份不确定）。这是能修的 bug。
 *   ②✗ ③✓        → 浏览器认、Node 不认 → Node 这边的请求形态（头顺序 / TLS 指纹）被盯上了。
 *   ②✗ ③✗        → 两边都不认 → **账号级风控**，只能等冷却，别再打。
 *
 *   node boss/diagnose.mjs
 */
import { SITE, effectiveCookieHeader, httpApi, isFlagged, loadSession, openSession } from "./lib.mjs";

const session = loadSession();
if (session === null) {
	console.error("没有 session.json");
	process.exit(1);
}

const get = async (label, cookie) => {
	const r = await httpApi("/wapi/zpuser/wap/getUserInfo.json", {}, { ...session, cookie }, { referer: `${SITE}/web/geek/chat` });
	const code = r.json?.code ?? null;
	const out = { label, code, message: r.json?.message ?? r.text?.slice(0, 60), flagged: isFlagged(r.json) };
	console.log(`  ${code === 0 ? "✓" : "✗"} ${label.padEnd(30)} code=${String(code).padEnd(5)} ${out.message ?? ""}`);
	return out;
};

console.log(`代理: ${(await import("./lib.mjs")).systemProxy() ?? "（直连）"}\n`);

const rawNames = session.cookie.split("; ").map((p) => p.split("=")[0]);
const dupes = rawNames.filter((n, i) => rawNames.indexOf(n) !== i);
console.log(`现有 cookie: ${rawNames.length} 项，其中重复名字 ${dupes.length} 个${dupes.length > 0 ? "：" + [...new Set(dupes)].join(", ") : ""}\n`);

console.log("── ①② Node 侧 ──");
const a = await get("① 原样 cookie（可能重复）", session.cookie);
await new Promise((r) => setTimeout(r, 1500));
const deduped = effectiveCookieHeader(
	rawNames.map((n, i) => ({ name: n, value: session.cookie.split("; ")[i].slice(n.length + 1), domain: ".zhipin.com", path: "/" })),
);
const b = await get("② 去重后的 cookie", deduped.header);

console.log("\n── ③ 浏览器侧（持久 profile，和登录时同一个）──");
const { ctx } = await openSession({ headless: true });
let c;
try {
	for (const p of ctx.pages()) await p.close().catch(() => {});
	await ctx.addCookies(
		deduped.header.split("; ").map((pair) => {
			const i = pair.indexOf("=");
			return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: ".zhipin.com", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 };
		}),
	);
	const page = await ctx.newPage();
	await page.goto(`${SITE}/wapi/zpgeek/common/data/header.json`, { waitUntil: "domcontentloaded", timeout: 45000 });
	const r = await page.evaluate(async () => {
		const res = await fetch("/wapi/zpuser/wap/getUserInfo.json?_=" + Date.now(), { credentials: "include", headers: { accept: "application/json, text/plain, */*" } });
		const t = await res.text();
		let j = null;
		try { j = JSON.parse(t); } catch { /* html */ }
		return { code: j?.code ?? null, message: j?.message ?? t.slice(0, 60) };
	});
	c = { code: r.code, message: r.message };
	console.log(`  ${r.code === 0 ? "✓" : "✗"} ${"③ 浏览器 + 去重 cookie".padEnd(30)} code=${String(r.code).padEnd(5)} ${r.message ?? ""}`);
} finally {
	await ctx.close();
}

console.log("\n── 结论 ──");
if (c.code === 0 && a.code !== 0) {
	console.log("  浏览器认、Node 不认。cookie 本身是好的 → 问题在 Node 这一侧的请求形态。");
	if (b.code === 0) console.log("  而且去重之后 Node 也认了 → **重复 cookie 就是根因**，已修（effectiveCookieHeader）。");
	else console.log("  去重没解决 → 不是重复 cookie，是 Node 请求的头/TLS 特征被盯上了。");
} else if (b.code === 0 && a.code !== 0) {
	console.log("  去重后 Node 认了 → **重复 cookie 就是根因**，已修（effectiveCookieHeader）。");
} else if (a.code !== 0 && b.code !== 0 && c.code !== 0) {
	console.log("  两边都不认 → **账号级风控**（或凭证已失效）。这种情况只能等冷却，别继续打。");
	console.log("  冷却后先跑 node boss/repair-session.mjs（不用重新扫码）。");
} else {
	console.log("  三个都认了 → 现在其实是登录态，可以直接抓。");
}
if (a.flagged || b.flagged) console.log("  ⚠ 出现了 code 35（风控信号）—— 立刻停手。");
