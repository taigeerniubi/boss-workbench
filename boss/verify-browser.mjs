/**
 * 过掉 Boss 的网页验证墙（`/web/passport/zp/verify.html`）。
 *
 * 为什么需要它：
 *   - Node 直连岗位接口回 `code 37 您的环境存在异常`（签名挑战），
 *   - 用无头浏览器去抓岗位，会被弹到 `verify.html`（滑块 / 短信那类真人验证），
 *   - 而 `getUserInfo` 同时回 `code 0` —— 说明**登录态是好的，缺的是"这个客户端可信"**。
 *
 * Boss 对"网页"和"接口"是两套信任。这一步的作用就是：**让真人过一次网页验证**，
 * 过完之后这个 persistent profile 就被打上信任标记，之后同 profile 的浏览器请求
 * （以及很多情况下 Node 的请求）就都通了。
 *
 * 所以这个脚本会开一个**有头**浏览器，把窗口交给你，你在里面把验证做完；
 * 脚本只负责盯着"什么时候算过"，然后立刻用真搜索验证一下结果。
 *
 *   node boss/verify-browser.mjs              走系统代理（和登录时一致）
 *   node boss/verify-browser.mjs --direct     直连，不走代理（Clash 把 zhipin 走了国外节点时用这个）
 *   node boss/verify-browser.mjs --search "后端开发"  --city 北京
 */
import { LAUNCH_ARGS, PROFILE_DIR, SITE, ensureDirs, systemProxy } from "./lib.mjs";
// loadChromium 在 playwright.mjs 里，**不是** lib.mjs 的导出 —— lib.mjs 只是 import 了它。
// 这种错 `node --check` 查不出来（它只解析语法、不解析 import 目标），要真跑才炸。
import { loadChromium } from "./playwright.mjs";
import { browserSearch } from "./browser-search.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const direct = flag("--direct");
const city = opt("--city", "北京");
const query = opt("--search", "后端开发");
const deadlineMs = Number(opt("--wait", "300")) * 1000;

ensureDirs();
const proxy = direct ? null : systemProxy();
console.log(`代理: ${proxy ?? "（直连）"}`);
console.log(direct ? "  模式: 直连 —— zhipin.com 在国内，直连通常比走梯子更像个正常用户" : "  模式: 走系统代理");
console.log("");

const chromium = await loadChromium();
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
	headless: false, // ← 必须是可见窗口，你要在里面过验证
	viewport: { width: 1280, height: 860 },
	locale: "zh-CN",
	timezoneId: "Asia/Shanghai",
	args: LAUNCH_ARGS,
	...(proxy === null ? {} : { proxy: { server: proxy } }),
});

try {
	const page = ctx.pages()[0] ?? (await ctx.newPage());
	let sawJobList = null;
	page.on("response", (res) => {
		if (res.url().includes("/wapi/zpgeek/search/joblist.json")) {
			res.json().then((j) => { sawJobList = { code: j?.code, msg: j?.message, n: j?.zpData?.jobList?.length }; }).catch(() => {});
		}
	});

	const target = `${SITE}/web/geek/jobs`;
	await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

	console.log("┌─────────────────────────────────────────────────────────────┐");
	console.log("│  浏览器窗口已经打开了，请在那个窗口里完成 Boss 的验证        │");
	console.log("│  （滑块 / 短信验证码 / 点一下「验证」——Boss 让做什么就做什么）│");
	console.log("│                                                             │");
	console.log("│  过完之后**别关窗口**，回到这里等 —— 脚本自己会发现。       │");
	console.log("└─────────────────────────────────────────────────────────────┘\n");

	const deadline = Date.now() + deadlineMs;
	let lastUrl = "";
	let sawJobsPage = false;
	let blankSince = 0;
	/**
	 * 判据只有一个：**页面上自己发出了 joblist，而且 code 0**。
	 *
	 * 第一版用的是"URL 离开了 verify.html 就算过"，实测**会骗人**：
	 * 用户那次根本没撞 verify.html，直接进了 /web/geek/jobs，于是立刻报"✓ 已通过"，
	 * 可页面一条 joblist 都没发，最后还落到了 about:blank。
	 * "离开验证页"离"能用"还差得远 —— 只有抓到真数据才算数。
	 */
	while (Date.now() < deadline) {
		await page.waitForTimeout(1000);
		const url = page.url();
		if (url !== lastUrl) {
			lastUrl = url;
			const onWall = url.includes("verify.html") || url.includes("/web/passport/");
			const blank = url === "about:blank" || url === "";
			console.log(`  ${new Date().toTimeString().slice(0, 8)}  ${onWall ? "⚠ 验证页" : blank ? "⚠ 页面变空白" : "→"}  ${url.slice(0, 110)}`);
			if (blank) blankSince = Date.now();
			else blankSince = 0;
		}
		if (url.includes("/web/geek/jobs") || url.includes("/web/geek/job-recommend")) sawJobsPage = true;
		if (sawJobList?.code === 0) break;
		// 页面白了好一会儿，也发了 joblist 但 code 不是 0 —— 不用再等了
		if (blankSince !== 0 && Date.now() - blankSince > 8000) break;
	}

	if (sawJobList?.code !== 0) {
		console.log(`\n✗ 没成功。判据是"页面自己发出 joblist 且 code 0"，这次没达到。`);
		if (sawJobsPage) {
			console.log(`  但它**确实进到了岗位页**，也没撞 verify.html —— 说明拦路的不是那道真人验证墙，`);
			console.log(`  而是 Boss 的网页端压根不认这个 profile 的登录态（页面最后落到了 ${page.url() || "空"}）。`);
			console.log(`  这跟 header.json 里 isLogin=false 是同一个信号：`);
			console.log(`  接口认这套 cookie（getUserInfo code 0），网页端不认。`);
		}
		if (sawJobList !== null) console.log(`  页面上发出的 joblist: code=${sawJobList.code} ${sawJobList.msg ?? ""}`);
		else console.log(`  页面上一条 joblist 都没发出来。`);
		console.log(`\n  这种情况下**继续重试没有意义**，而且会让风控分数更高。`);
		console.log(`  建议就停在这儿：等一段时间（几小时起）再试，别连着打。`);
		process.exit(2);
	}
	console.log(`\n✓ 成功：页面自己发出了 joblist，code=0，${sawJobList.n ?? 0} 条。`);
} finally {
	await ctx.close();
}

// ── 用"真搜索"验收：profile 现在可信了吗？────────────────────────────────
console.log(`\n── 验收：用这个 profile 搜一次「${city} · ${query}」──`);
const r = await browserSearch({ city, query, log: (s) => console.log(s), diagnose: true });
console.log(`\nok=${r.ok} code=${r.code} ${r.message ?? ""}  (截到 ${r.attempts ?? 0} 次 joblist 响应)`);
if (r.diagnose?.hits) for (const h of r.diagnose.hits) console.log(`  ${h.status} code=${h.code} ${h.msg ?? ""} jobList=${h.n ?? "—"}`);
if (r.ok && r.jobs.length > 0) {
	console.log(`\n✓ 抓到了 ${r.jobs.length} 条：`);
	for (const j of r.jobs.slice(0, 5)) console.log(`  ${j.brandName} · ${j.jobName} · ${j.salaryDesc} · ${j.cityName}${j.areaDistrict ? "·" + j.areaDistrict : ""}`);
	console.log(`\n字段名: ${Object.keys(r.jobs[0]).join(", ")}`);
	console.log(`\n下一步：把这个结果接进 runScrape —— 现在 search 模式还只走 Node。`);
	process.exit(0);
}
console.log(`\n✗ 还是不行。页面落点: ${r.onPage ?? ""}`);
console.log(`  如果落点还是 verify.html，说明验证没真正过掉；`);
console.log(`  如果这次连 joblist 都没发出来，看看窗口里页面是不是白屏。`);
process.exit(3);
