/**
 * 验证会话区右下角那颗余额 pill 的位置：它必须落在 shell 自己的
 * 「用量 · 缓存命中」（`[data-composer-stats]`）之后。
 *
 * 客户端半边会热重载，所以这个不用重启 GUI 就能看；只有数字要等宿主路由起来。
 */
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { loadChromium } from "./playwright.mjs";

const ORIGIN = "http://127.0.0.1:3080";
const HOST = "127.0.0.1:3080";
const cred = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, "utf8");
const secret = Buffer.from(cred.match(/secret:\s*([A-Za-z0-9_-]+)/)[1].replaceAll("-", "+").replaceAll("_", "/"), "base64");
const b64u = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const issuedAt = Date.now();
const expiresAt = issuedAt + 30 * 86400 * 1000;
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority: HOST, issuedAt, expiresAt }), "utf8"));

const chromium = await loadChromium();
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "chrome" }));
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
await ctx.addCookies([{
	name: "dsh-auth-" + b64u(createHash("sha256").update(HOST).digest()),
	value: `v1.${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`,
	domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict", expires: Math.floor(expiresAt / 1000),
}]);
const page = await ctx.newPage();
await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);

// 空白会话没有 composer，也就没有 composer.dock —— 必须先打开一个真会话
const row = page.locator('[class*="sessionRow"]').first();
if ((await row.count()) > 0) {
	await row.click();
	console.log("已打开侧栏第一个会话");
	await page.waitForTimeout(6000);
} else {
	console.log("⚠️ 侧栏没找到会话行");
}

const info = await page.evaluate(() => {
	const box = (el) => {
		if (el === null) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	};
	const stats = document.querySelector("[data-composer-stats]");
	const pill = document.querySelector(".bw_balPill");
	return {
		stats: box(stats),
		pill: box(pill),
		pillText: pill?.textContent ?? null,
		statsText: (stats?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
		sameRow: stats !== null && pill !== null && Math.abs(stats.getBoundingClientRect().y - pill.getBoundingClientRect().y) < 20,
	};
});

console.log("shell 的「用量 · 缓存命中」:", JSON.stringify(info.stats), info.statsText);
console.log("插件的「余额」pill      :", JSON.stringify(info.pill), info.pillText);
console.log(`判定: ${info.pill === null ? "❌ pill 没渲染出来" : info.sameRow ? "✅ 和用量 pill 同一行（在它后面）" : "⚠️ 渲染了但不在同一行（在下面一行）"}`);

mkdirSync(new URL("./preview/", import.meta.url), { recursive: true });
const y = info.pill === null ? 700 : Math.max(0, info.pill.y - 40);
await page.screenshot({ path: new URL("gui-balance-pill.png", new URL("./preview/", import.meta.url)).pathname.replace(/^\//u, ""), clip: { x: 700, y, width: 740, height: 120 } });
console.log("已截图 preview/gui-balance-pill.png");
await browser.close();
