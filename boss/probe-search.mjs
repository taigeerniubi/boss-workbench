/**
 * 两个岗位接口各问一次，看 Node 这边到底哪个能走。
 *
 * 背景：`getUserInfo` 回 code 0（登录态是真的），但搜索接口回 code 37「环境存在异常」。
 * 那就得分开测：推荐流 / 搜索，各自一次，绝不连发。
 *
 *   node boss/probe-search.mjs
 */
import { httpApi, loadSession } from "./lib.mjs";

const session = loadSession();
if (session === null) {
	console.error("没有 data/session.json");
	process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const brief = (r) => {
	const j = r.json;
	const z = j?.zpData;
	const n = Array.isArray(z?.jobList) ? z.jobList.length : undefined;
	return `HTTP ${r.status} code=${j?.code} msg=${String(j?.message ?? "").slice(0, 30)}`
		+ (n === undefined ? ` zpKeys=${z && typeof z === "object" ? Object.keys(z).slice(0, 5).join(",") : typeof z}` : ` jobList=${n}`);
};

const cases = [
	["recommend", "/wapi/zpgeek/pc/recommend/job/list.json", { page: 1, pageSize: 15 }, "https://www.zhipin.com/web/geek/job-recommend"],
	["search", "/wapi/zpgeek/search/joblist.json", { scene: 1, query: "后端开发", city: "101010100", page: 1, pageSize: 15 }, "https://www.zhipin.com/web/geek/jobs"],
];

for (const [label, path, params, referer] of cases) {
	const r = await httpApi(path, params, session, { referer });
	console.log(`${label.padEnd(10)} ${brief(r)}`);
	const first = r.json?.zpData?.jobList?.[0];
	if (first !== undefined) {
		console.log(`           sample: ${first.brandName} · ${first.jobName} · ${first.salaryDesc} · ${first.cityName}${first.areaDistrict ? "·" + first.areaDistrict : ""}`);
		console.log(`           keys  : ${Object.keys(first).join(", ")}`);
	}
	await sleep(4000);
}
