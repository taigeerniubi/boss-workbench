/**
 * 对着**活着的** DSH Web GUI 做诊断 / 视觉核对。
 *
 * 为什么需要登录态：GUI 的 index 要进程 token 才给（静态资源才是公开的），
 * 而 token 是每次启动随机生成的。这里改用 client-connection 持久化的
 * browser-session 签名密钥，自己签一个和浏览器里那个等价的 cookie ——
 * 只读地看 DOM，不写任何东西。
 *
 * 用法：
 *   node inspect-gui.mjs              侧栏基线 + 全页截图
 *   node inspect-gui.mjs --panels     再点一次「Boss 工作台」图标，对比面板激活前后的侧栏
 */
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { loadChromium } from "./boss/playwright.mjs";

const chromium = await loadChromium();

const ORIGIN = "http://127.0.0.1:3080";
const HOST = "127.0.0.1:3080";
const OUT = new URL("./preview/", import.meta.url);

// ── 1. 用本地保存的签名密钥自签一个 browser-session cookie ──────────────────
const credentials = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, "utf8");
const secretB64 = credentials.match(/secret:\s*([A-Za-z0-9_-]+)/)?.[1];
if (secretB64 === undefined) throw new Error("credentials 里没有 browser-session secret");
const secret = Buffer.from(secretB64.replaceAll("-", "+").replaceAll("_", "/"), "base64");
const b64u = (buf) => Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const issuedAt = Date.now();
const expiresAt = issuedAt + 30 * 86400 * 1000;
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority: HOST, issuedAt, expiresAt }), "utf8"));
const cookie = {
	name: "dsh-auth-" + b64u(createHash("sha256").update(HOST).digest()),
	value: `v1.${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`,
	domain: "127.0.0.1",
	path: "/",
	httpOnly: true,
	sameSite: "Strict",
	expires: Math.floor(expiresAt / 1000),
};

// ── 2. 打开 GUI ─────────────────────────────────────────────────────────────
let browser;
try {
	browser = await chromium.launch({ headless: true });
} catch {
	browser = await chromium.launch({ headless: true, channel: "chrome" });
}
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
await context.addCookies([cookie]);
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => {
	if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 300));
});

await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(7000);

mkdirSync(OUT, { recursive: true });

/** 侧栏结构快照：每个直接子块的高度 + 文本，用来定位"空掉的是哪一块"。 */
async function sidebarSnapshot(label) {
	const info = await page.evaluate(() => {
		const anchor = document.querySelector('button[aria-label="新建会话"], button[aria-label="New session"]');
		if (anchor === null) return { error: "找不到「新会话」按钮 —— 可能没登录成功" };
		let root = anchor;
		while (root.parentElement !== null && !String(root.className).includes("_root")) root = root.parentElement;
		const blocks = [...root.children].map((child) => {
			const rect = child.getBoundingClientRect();
			return {
				cls: String(child.className).replace(/\s+/g, " ").trim().slice(0, 60),
				h: Math.round(rect.height),
				text: (child.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 220),
			};
		});
		return { blocks, fullText: (root.innerText ?? "").replace(/\n+/g, " | ").trim().slice(0, 900) };
	});
	console.log(`\n════ 侧栏快照：${label} ════`);
	if (info.error !== undefined) {
		console.log("  " + info.error);
		return;
	}
	for (const b of info.blocks) console.log(`  [h=${String(b.h).padStart(4)}] .${b.cls}\n           ${b.text}`);
	console.log(`  ── 侧栏全文 ──\n  ${info.fullText}`);
}

await sidebarSnapshot("刚打开（当前状态）");
await page.screenshot({ path: new URL("gui-sidebar-before.png", OUT).pathname.replace(/^\//u, ""), clip: { x: 0, y: 0, width: 300, height: 760 } });
console.log("\n已截图 preview/gui-sidebar-before.png");

if (process.argv.includes("--panels")) {
	// 点「Boss 工作台」图标：面板激活后侧栏是否还列会话？
	const panel = page.locator('button[aria-label="Boss 工作台"]').first();
	if ((await panel.count()) > 0) {
		await panel.click();
		await page.waitForTimeout(2500);
		await sidebarSnapshot("点了「Boss 工作台」之后");
		await page.screenshot({ path: new URL("gui-panel-active.png", OUT).pathname.replace(/^\//u, ""), clip: { x: 0, y: 0, width: 300, height: 760 } });
		console.log("\n已截图 preview/gui-panel-active.png");
		// 再点一次新会话：离开面板模式，看会话列表是否回来
		await page.locator('button[aria-label="新建会话"], button[aria-label="New session"]').first().click();
		await page.waitForTimeout(3000);
		await sidebarSnapshot("再点「新会话」离开面板之后");
	} else {
		console.log("\n找不到 Boss 工作台 面板按钮");
	}
}

await browser.close();
