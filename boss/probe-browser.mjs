/**
 * 探针（第二轮）：绕开 SPA 的跳转，直接在一个 zhipin 源上问浏览器三个问题：
 *   1. getUserInfo 认不认我？  2. header.json 的 isLogin 是啥？  3. wapi 接口在浏览器里还回 code 37 吗？
 *
 * 关键点：先在 zhipin 域上落一个文档（哪怕它是个 JSON），再 fetch —— 这样 Origin 对了，
 * cookie 又是 profile 级的，SPA 那套跳转干扰不到我们。
 *
 *   node boss/probe-browser.mjs
 */
import { openSession, SITE, systemProxy } from "./lib.mjs";

console.log("代理 :", String(systemProxy()));
const { ctx } = await openSession({ headless: true });
for (const p of ctx.pages()) await p.close().catch(() => {});
const page = await ctx.newPage();

try {
	// 1) 先在 zhipin 上落一个文档，拿到同源上下文
	await page.goto(`${SITE}/wapi/zpgeek/common/data/header.json`, { waitUntil: "domcontentloaded", timeout: 60000 });
	console.log("落点 :", page.url().slice(0, 120));

	const out = await page.evaluate(async () => {
		const get = async (path) => {
			const r = await fetch(path + (path.includes("?") ? "&" : "?") + "_=" + Date.now(), {
				credentials: "include",
				headers: { accept: "application/json, text/plain, */*" },
			});
			const t = await r.text();
			let j = null;
			try { j = JSON.parse(t); } catch { /* HTML */ }
			const z = j?.zpData;
			return {
				status: r.status,
				code: j?.code,
				msg: String(j?.message ?? "").slice(0, 40),
				jobList: Array.isArray(z?.jobList) ? z.jobList.length : undefined,
				zpKeys: z && typeof z === "object" ? Object.keys(z).slice(0, 8) : typeof z,
				raw: j === null ? t.replace(/\s+/gu, " ").slice(0, 260) : undefined,
			};
		};
		const userInfo = await get("/wapi/zpuser/wap/getUserInfo.json");
		const recommend = await get("/wapi/zpgeek/pc/recommend/job/list.json?page=1&pageSize=15");
		const search = await get("/wapi/zpgeek/search/joblist.json?scene=1&query=Java&city=101020100&page=1&pageSize=15");
		return { userInfo, recommend, search };
	});
	for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(10)}: ${JSON.stringify(v)}`);

	const full = await ctx.cookies();
	console.log("\nprofile 全部 cookie:", full.map((c) => `${c.name}(${c.value.length})`).join(" "));
} finally {
	await ctx.close();
}
