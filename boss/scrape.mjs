/**
 * 抓岗位 → data/jobs.json（纯 HTTP，不开浏览器）
 *
 * 浏览器只在登录那一步出场（换 __zp_stoken__），抓取完全走 wapi JSON。
 * 真正干活的逻辑在 jobs.mjs 的 runScrape() —— 工作台上的「抓取」按钮走的是同一个函数。
 * 两种模式：
 *   --mode search    关键词 + 城市搜索（默认）→ /wapi/zpgeek/search/joblist.json
 *   --mode recommend 推荐流（参考项目实测可用的那个）→ /wapi/zpgeek/pc/recommend/job/list.json
 *
 * 用法：
 *   node boss/scrape.mjs --city 北京 --query "后端开发" --yes
 *   node boss/scrape.mjs --mode recommend --experience 三到五年 --salary 20-50k --yes
 *
 * 三个硬约束（账号比数据重要）：
 *   1. code 35（IP 异常）立刻停，不重试、不换姿势硬撞；
 *   2. 页间随机延时 3~8s，默认只抓 3 页；
 *   3. 不加 --yes 只打印计划，完全不碰网络。
 */
import { join } from "node:path";
import { DATA_DIR, filterJobs, loadProfile, loadSession, loginStateHttp, readJson, resolveCity } from "./lib.mjs";
// 真正干活的逻辑在 jobs.mjs —— 宿主路由 /boss/scrape 走的是同一个函数，
// 这样"终端里能抓到的"和"工作台上能抓到的"永远是一回事。
import { runScrape } from "./jobs.mjs";

function parseArgs(argv) {
	const out = {
		mode: "search", pages: 3, pageSize: 30, minDelay: 3000, maxDelay: 8000, yes: false,
		city: null, query: null, maxKm: null, experience: null, jobType: null, salary: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--mode") out.mode = next();
		else if (a === "--city") out.city = next();
		else if (a === "--query") out.query = next();
		else if (a === "--pages") out.pages = Number(next());
		else if (a === "--page-size") out.pageSize = Number(next());
		else if (a === "--max-km") out.maxKm = Number(next());
		else if (a === "--experience") out.experience = next();
		else if (a === "--job-type") out.jobType = next();
		else if (a === "--salary") out.salary = next();
		else if (a === "--min-delay") out.minDelay = Number(next());
		else if (a === "--max-delay") out.maxDelay = Number(next());
		else if (a === "--yes") out.yes = true;
		else if (a === "--help" || a === "-h") out.help = true;
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	console.log(`抓岗位 → data/jobs.json（纯 HTTP）

  --mode search|recommend   默认 search（关键词 + 城市）；recommend 是参考项目实测可用的推荐流
  --city <名字>             城市（默认取 data/profile.json 的 homeCity）
  --query <关键词>          岗位关键词（search 模式用）
  --experience <档位>       在校生/应届生/不限/一年以内/一到三年/三到五年/五到十年/十年以上
  --job-type <全职|兼职>
  --salary <3k以下|3-5k|5-10k|10-20k|20-50k|50以上>
  --pages <n> --page-size <n> --max-km <n> --min-delay <ms> --max-delay <ms>
  --yes                     真正执行（不加只打印计划）
`);
	process.exit(0);
}

const profile = loadProfile();
const session = loadSession();
const city = args.city ?? profile.homeCity;
const query = args.query ?? profile.keywords?.[0] ?? "";
const maxKm = args.maxKm ?? null;
const cityCode = resolveCity(city);

console.log(`抓取计划（${args.mode}）`);
console.log(`  会话   : ${session === null ? "⚠ data/session.json 不存在 —— 先跑 node boss/login.mjs" : `已保存于 ${session.savedAt ?? "?"}`}`);
console.log(`  城市   : ${city}${cityCode === null ? "  ⚠ 没有城市码（先登录以缓存城市表，或改用内置的 北京/上海）" : ` (${cityCode})`}`);
if (args.mode === "search") console.log(`  关键词 : ${query || "(空)"}`);
else console.log(`  筛选项 : 经验=${args.experience ?? "不限"} 类型=${args.jobType ?? "不限"} 薪资=${args.salary ?? "不限"}`);
console.log(`  页数   : ${args.pages} × ${args.pageSize} 条，页间延时 ${args.minDelay}~${args.maxDelay}ms`);
console.log(`  距离   : ${maxKm === null ? "不限" : `≤ ${maxKm}km`}${profile.homeGeo === null && readJson(join(DATA_DIR, "geo.json"), null) === null ? "  ⚠ 没有坐标来源，距离多半是「距离未知」（见下）" : ""}`);
if (session === null) process.exit(1);
if (args.mode === "search" && cityCode === null) process.exit(2);
if (!args.yes) {
	console.log("\n(未加 --yes，只打印计划。确认后再跑。)");
	process.exit(0);
}

const result = await runScrape({
	mode: args.mode,
	city,
	query,
	maxKm,
	pages: args.pages,
	pageSize: args.pageSize,
	minDelay: args.minDelay,
	maxDelay: args.maxDelay,
	experience: args.experience,
	jobType: args.jobType,
	salary: args.salary,
	log: (line) => console.log(`  ${line}`),
});

if (!result.ok && result.stopped !== null && result.stopped !== undefined) {
	console.error(`\n✗ 第 ${result.fetched === 0 ? 1 : "?"} 页中断：${result.stopped.message}`);
}
if (result.reason !== undefined) {
	console.error(`\n✗ ${result.error}`);
	process.exit(3);
}

console.log(`\n落盘`);
console.log(`  data/jobs.json : 共 ${result.total} 条（本次新增 ${result.added}，抓回 ${result.fetched}）`);
const jobs = readJson(join(DATA_DIR, "jobs.json"), { jobs: [] })?.jobs ?? [];
if (maxKm !== null) console.log(`  ≤ ${maxKm}km     : ${filterJobs(jobs, { maxKm }).length} 条`);
const near = jobs.filter((j) => j.distanceKm !== null).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 5);
if (near.length > 0) {
	console.log("  最近的几个:");
	for (const j of near) console.log(`    ${String(j.distanceKm).padStart(5)}km  ${j.company} · ${j.title}  [${j.city}${j.area ? "·" + j.area : ""}]`);
} else {
	console.log("  距离：一条都没算出来。说明接口里确实没有距离字段 ——");
	console.log("    wapi 的 jobList 只有 cityName / areaDistrict，没有坐标，也没有 distance。");
	console.log("    想真算距离，就在 data/geo.json 里建一张「商圈 → 坐标」表，例如：");
	console.log(`      { "海淀区·中关村": { "lng": 116.31, "lat": 39.98 } }`);
	console.log("    配合 data/profile.json 的 homeGeo，即可按 Haversine 算；没有的商圈显示「距离未知」。");
}

// 顺手把登录态也报一下，方便判断是"抓完了"还是"被抓了"
const state = await loginStateHttp(session);
if (state.flagged) console.log("\n⚠ 结束时登录态检查发现 code 35 —— 短期内别再抓。");
if (state.loggedIn === false) console.log("\n⚠ 登录态检查说 isLogin=false —— cookie 已经不作数了，重新登录。");
