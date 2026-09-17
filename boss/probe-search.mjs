/**
 * 探针：为什么 search 接口回 code 37，而 recommend 据说能用？
 *
 * 只读，不改任何状态。一次跑 4 个请求，页间 sleep，别把账号撞疼。
 *   node boss/probe-search.mjs
 */
import { httpApi, loadProfile, loadSession, loginStateHttp } from "./lib.mjs";

const session = loadSession();
if (session === null) {
	console.error("没有 data/session.json");
	process.exit(1);
}
const profile = loadProfile();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (r) => {
	const j = r.json;
	const z = j?.zpData;
	const n = Array.isArray(z?.jobList) ? z.jobList.length : undefined;
	return `HTTP ${r.status} code=${j?.code} msg=${String(j?.message ?? "").slice(0, 40)}`
		+ (n === undefined ? ` zpDataKeys=${z && typeof z === "object" ? Object.keys(z).slice(0, 6).join(",") : typeof z}` : ` jobList=${n}`);
};

console.log("登录态:", JSON.stringify(await loginStateHttp(session)));
await sleep(1500);

const cases = [
	["recommend", "/wapi/zpgeek/pc/recommend/job/list.json", { page: 1, pageSize: 15 }, "https://www.zhipin.com/web/geek/job-recommend"],
	["search(scene1)", "/wapi/zpgeek/search/joblist.json", { scene: 1, query: "Java", city: "101020100", page: 1, pageSize: 15 }, "https://www.zhipin.com/web/geek/jobs"],
	["search(scene2)", "/wapi/zpgeek/search/joblist.json", { scene: 2, query: "Java", city: "101020100", page: 1, pageSize: 15 }, "https://www.zhipin.com/web/geek/jobs"],
	["search(no query)", "/wapi/zpgeek/search/joblist.json", { scene: 1, city: "101020100", page: 1, pageSize: 15 }, "https://www.zhipin.com/web/geek/jobs"],
];

for (const [label, path, params, referer] of cases) {
	const r = await httpApi(path, params, session, { referer });
	console.log(`${label.padEnd(16)} ${brief(r)}`);
	const first = r.json?.zpData?.jobList?.[0];
	if (first !== undefined) {
		console.log(`                 sample: ${first.brandName} · ${first.jobName} · ${first.salaryDesc} · ${first.cityName}${first.areaDistrict ? "·" + first.areaDistrict : ""}`);
	}
	await sleep(4000);
}
console.log("\nprofile:", JSON.stringify({ city: profile.homeCity, keywords: profile.keywords, homeGeo: profile.homeGeo ?? null }));
