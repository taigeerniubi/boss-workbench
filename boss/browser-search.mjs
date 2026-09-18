/**
 * 用**浏览器**搜岗位。
 *
 * 为什么需要它：Node 直连 `search/joblist.json` 和 `recommend/job/list.json` 现在都回
 * `code 37 您的环境存在异常`，而同一时刻 `getUserInfo` 回 `code 0` —— 也就是**登录态是好的**。
 * 37 的响应体长这样：
 *
 *     {"code":37,"message":"您的环境存在异常.","zpData":{"seed":"…","name":"76215708","ts":1789641267797}}
 *
 * 这是个**签名挑战**：Boss 要的不是"你登录了没有"，而是"这个请求是不是它自己的页面发的"。
 * `seed` / `name` / `ts` 三个字段说明服务端在等一个由它们算出来的东西 —— 而那套算法在
 * Boss 自己的 JS bundle 里，且会变。硬逆向它是在跟一个每天变的目标赛跑。
 *
 * 所以换个思路：**让 Boss 自己的页面去发这个请求**，我们只截它的 JSON。
 * 页面本来就会带对签名、对 header、对 cookie，而且这些东西是它自己维护的。
 * 代价是慢（要开浏览器、要等页面），收益是**不用跟着算法变**。
 *
 * 浏览器在整个链路里本来是"只负责过安全验证"，这里扩成"也负责发搜索请求"，
 * 仍然只有这一处开浏览器，抓回来的数据照样是同一套 wapi JSON。
 */
import { pathToFileURL } from "node:url";
import { SITE, openSession, resolveCity } from "./lib.mjs";

/** 从 URL 里把 city 码取出来；查不到城市码就直接报错（别发一个没城市的请求）。 */
const SEARCH_URL = (cityCode, query, page) =>
	`${SITE}/web/geek/jobs?city=${encodeURIComponent(cityCode)}&query=${encodeURIComponent(query)}&page=${page}`;

/**
 * 打开工作台所在的那个持久 profile，导航到搜索页，截下 joblist 响应。
 *
 * @param {object} opts
 * @param {string} opts.city        城市名
 * @param {string} opts.query       关键词
 * @param {number} [opts.page]      第几页（默认 1）
 * @param {(s:string)=>void} [opts.log]
 * @param {boolean} [opts.diagnose] 多回一些诊断信息（请求头、页面落点）
 * @returns {Promise<{ok:boolean, jobs:object[], code:number|null, message:string|null, url:string, diagnose?:object, error?:string}>}
 */
export async function browserSearch({ city, query, page = 1, log = () => {}, diagnose = false, timeoutMs = 30000 }) {
	const cityCode = resolveCity(city);
	if (cityCode === null) return { ok: false, jobs: [], code: null, message: null, url: "", error: `没有「${city}」的城市码` };
	if (String(query).trim() === "") return { ok: false, jobs: [], code: null, message: null, url: "", error: "关键词是空的" };

	const target = SEARCH_URL(cityCode, query, page);
	const { ctx } = await openSession({ headless: true });
	try {
		for (const p of ctx.pages()) await p.close().catch(() => {});
		const pageObj = await ctx.newPage();

		/** 截下来的候选响应。页面可能因为瀑布流/重试发多次，取最后一个 code 0 的。 */
		const hits = [];
		pageObj.on("response", (res) => {
			const u = res.url();
			if (!u.includes("/wapi/zpgeek/search/joblist.json")) return;
			res
				.json()
				.then((json) => hits.push({ url: u, status: res.status(), json, headers: res.request().headers() }))
				.catch(() => {});
		});

		log(`  打开 ${target.slice(0, 120)}`);
		await pageObj.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });

		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (hits.some((h) => h.json?.code === 0)) break;
			// 页面可能弹了验证/登录遮罩，等也没用 —— 出现 code 37 也别立刻放弃，页面偶尔会重试
			await pageObj.waitForTimeout(400);
		}
		// 给最后那个 .json() 一点落地时间
		await pageObj.waitForTimeout(600);

		const ok = hits.filter((h) => h.json?.code === 0);
		const best = ok.length > 0 ? ok[ok.length - 1] : hits[hits.length - 1] ?? null;
		const out = {
			ok: best?.json?.code === 0,
			jobs: best?.json?.zpData?.jobList ?? [],
			code: best?.json?.code ?? null,
			message: best?.json?.message ?? null,
			url: best?.url ?? target,
			onPage: pageObj.url().slice(0, 160),
			attempts: hits.length,
		};
		if (diagnose) {
			out.diagnose = {
				landedOn: pageObj.url().slice(0, 200),
				title: await pageObj.title().catch(() => ""),
				hits: hits.map((h) => ({ status: h.status, code: h.json?.code, msg: h.json?.message, n: h.json?.zpData?.jobList?.length })),
				requestHeaders: best?.headers ?? null,
			};
		}
		return out;
	} catch (err) {
		return { ok: false, jobs: [], code: null, message: null, url: target, error: String(err?.message ?? err).split("\n")[0] };
	} finally {
		await ctx.close();
	}
}

// ── 直接跑：node boss/browser-search.mjs [城市] [关键词] ────────────────────
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const city = process.argv[2] ?? "北京";
	const query = process.argv[3] ?? "后端开发";
	console.log(`浏览器搜索: ${city} · ${query}\n`);
	const r = await browserSearch({ city, query, log: console.log, diagnose: true });
	console.log(`\nok=${r.ok} code=${r.code} ${r.message ?? ""}  (截到 ${r.attempts ?? 0} 次响应)`);
	console.log(`页面落点: ${r.onPage ?? ""}`);
	if (r.diagnose) {
		console.log(`\n抓到的响应:`);
		for (const h of r.diagnose.hits) console.log(`  ${h.status} code=${h.code} ${h.msg ?? ""} jobList=${h.n}`);
		if (r.diagnose.requestHeaders) {
			console.log(`\n页面自己发的请求头（对照我们 Node 那边缺什么）:`);
			for (const [k, v] of Object.entries(r.diagnose.requestHeaders)) {
				if (/cookie/i.test(k)) { console.log(`  ${k}: <${String(v).length} 字节，略>`); continue; }
				console.log(`  ${k}: ${String(v).slice(0, 120)}`);
			}
		}
	}
	if (r.jobs.length > 0) {
		console.log(`\n前 3 条:`);
		for (const j of r.jobs.slice(0, 3)) console.log(`  ${j.brandName} · ${j.jobName} · ${j.salaryDesc} · ${j.cityName}${j.areaDistrict ? "·" + j.areaDistrict : ""}`);
		console.log(`\n字段名（用来收敛 normalizeJob）:\n  ${Object.keys(r.jobs[0]).join(", ")}`);
	}
}
