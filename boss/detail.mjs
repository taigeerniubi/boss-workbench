import { join } from "node:path";
import { browserJson, classifyBossResponse, connectExistingBossBrowser } from "./browser-channel.mjs";
import { DATA_DIR, markCooldown, readJson, writeJson } from "./lib.mjs";

export const DETAIL_PATH = "/wapi/zpgeek/job/detail.json";

export function mapJobDetail(current, data) {
	const job = data?.jobInfo ?? data?.jobDetail ?? {};
	const boss = data?.bossInfo ?? {};
	const brand = data?.brandComInfo ?? {};
	return {
		...current,
		id: String(job.encryptJobId ?? job.encryptId ?? current?.id ?? ""),
		encryptJobId: String(job.encryptJobId ?? job.encryptId ?? current?.encryptJobId ?? current?.id ?? ""),
		title: job.jobName ?? job.jobTitle ?? current?.title ?? "",
		company: brand.brandName ?? brand.companyName ?? job.brandName ?? current?.company ?? "",
		salary: job.salaryDesc ?? job.salary ?? current?.salary ?? "面议",
		city: job.cityName ?? current?.city ?? "",
		area: [job.areaDistrict, job.businessDistrict].filter(Boolean).join("·") || current?.area || "",
		jd: job.postDescription ?? job.jobDescription ?? data?.jobDetail?.postDescription ?? current?.jd ?? "",
		hr: boss.name ?? boss.bossName ?? current?.hr ?? "",
		hrTitle: boss.title ?? boss.bossTitle ?? current?.hrTitle ?? "",
		industry: brand.industryName ?? brand.brandIndustry ?? current?.industry ?? "",
		scale: brand.brandScaleName ?? current?.scale ?? "",
		stage: brand.brandStageName ?? current?.stage ?? "",
		experience: job.experienceName ?? job.jobExperience ?? current?.experience ?? "",
		degree: job.degreeName ?? job.jobDegree ?? current?.degree ?? "",
		welfare: job.welfareList ?? current?.welfare ?? [],
		detailFetchedAt: new Date().toISOString(),
	};
}

const cooldownFor = (kind, message) => {
	if (["ip-risk", "account-risk", "environment-risk", "browser-blocked", "rate-limited"].includes(kind)) {
		markCooldown({ kind, message });
	}
};

/** 显式点击后才抓一个 JD；绝不批量补全。
 *
 * 详情接口的定位参数，两个参考实现**各说各话**：
 *   - zhipin-geek 的 `get_job_detail()`：`{"securityId": ..., "lid": ...}`
 *   - boss-agent-cli 的 `job_detail()`：`{"encryptJobId": ...}`
 * 两边都在真实账号上跑过 job/detail.json，所以这里**两个都发**：
 * 服务端取它认的那个、忽略另一个，这比赌其中一个更稳。
 * 关键是只发**一次**请求 —— 不搞"先试 A，失败了再拿 B 重打一遍"，
 * 那种写法在 Boss 眼里就是两次请求，正是要避免的。
 */
export async function fetchJobDetail(id, { transport = null, save = true } = {}) {
	const jobsPath = join(DATA_DIR, "jobs.json");
	const file = readJson(jobsPath, { version: 1, jobs: [] }) ?? { version: 1, jobs: [] };
	const current = (file.jobs ?? []).find((job) => job.id === id || job.encryptJobId === id);
	if (current === undefined) return { ok: false, reason: "not-found", error: `岗位 ${id} 不在岗位库里` };
	const securityId = current.securityId || "";
	const encryptJobId = current.encryptJobId || current.id || "";
	if (securityId === "" && encryptJobId === "") return { ok: false, reason: "no-job-key", error: "这条岗位既没有 securityId 也没有 encryptJobId，无法取详情；请重新抓一次岗位列表" };
	const request = transport?.request ?? (async (path, params, options) => {
		// autoLaunch：窗口被关掉后，取 JD 也该能自己再拉一个。
		const linked = await connectExistingBossBrowser({ autoLaunch: true });
		if (!linked.loggedIn) throw new Error("那个浏览器里的 Boss 登录态已失效，请在弹出的窗口里重新登录");
		return browserJson(linked.page, path, params, options);
	});
	let response;
	try {
		const params = {};
		if (securityId) params.securityId = securityId;
		if (encryptJobId) params.encryptJobId = encryptJobId;
		// lid 是列表条目里那次的检索票，和 securityId 配套（securityId 每次搜索会换）。
		if (current.lid) params.lid = current.lid;
		response = await request(DETAIL_PATH, params, { referer: current.url });
	} catch (err) {
		return { ok: false, reason: err?.code ?? "browser", error: String(err?.message ?? err) };
	}
	const state = classifyBossResponse(response.json, response);
	if (state.kind !== "success") {
		cooldownFor(state.kind, `JD 详情请求被终止：${response.json?.message ?? state.kind}`);
		return { ok: false, reason: state.kind, error: response.json?.message ?? `JD 详情请求失败：${state.kind}` };
	}
	const updated = mapJobDetail(current, response.json?.zpData ?? {});
	if (save) {
		const jobs = (file.jobs ?? []).map((job) => job.id === current.id ? updated : job);
		writeJson(jobsPath, { ...file, updatedAt: new Date().toISOString(), count: jobs.length, jobs });
	}
	return { ok: true, job: updated };
}
