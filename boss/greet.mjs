/**
 * 打招呼：用「简历 + JD」生成话术，并把它发出去。
 *
 * 两条设计选择，都是为了将来能无痛换成 agent：
 *   1. **生成与发送分离**：`buildGreeting()` 是纯函数（给定输入必得同一输出，可离线测试），
 *      `sendGreeting()` 只负责网络。将来把 buildGreeting 换成"派一个 DSH 会话去写"，
 *      上层和 UI 都不用动。
 *   2. **打分先于写话**：先把 JD 的要求与简历做成匹配/缺口两列，话术只引用**真的命中**的点。
 *      这样不会出现"我很熟悉 Kafka"而简历里根本没有 Kafka 的鬼话。
 *
 * Cookd 那套结构化简历的价值就在这里：`skills` / `experience` / `yoe` / `degree`
 * 正好是打分需要的字段，不用再回头去啃全文。
 */
import { browserJson, classifyBossResponse, connectExistingBossBrowser } from "./browser-channel.mjs";
import { markCooldown } from "./lib.mjs";

const STOP = new Set(["负责", "参与", "熟悉", "了解", "掌握", "具备", "优先", "要求", "岗位", "职责", "任职", "工作", "相关", "经验", "能力", "良好", "以上", "以及", "能够", "独立", "熟练"]);

/** 把一段文本切成用于比对的词（英文词 + 中文 2-4 字片段）。 */
function terms(text) {
	const out = new Set();
	for (const m of String(text).matchAll(/[A-Za-z][A-Za-z0-9+.#-]{1,20}/gu)) out.add(m[0].toLowerCase());
	for (const m of String(text).matchAll(/[\u4e00-\u9fff]{2,6}/gu)) {
		const w = m[0];
		if (!STOP.has(w) && w.length <= 6) out.add(w);
	}
	return out;
}

/**
 * 简历 vs 岗位：命中 / 缺口 / 分数。
 * 分数刻意做得粗糙且可解释（命中数 / 要求数），因为它的用途是**排序和解释**，
 * 不是当相似度模型用 —— 真要语义匹配就是 Cookd 那条 Milvus 多路召回的路，后面再说。
 */
export function matchResumeToJob(resume, job) {
	const jobText = `${job.title ?? ""} ${job.jd ?? ""} ${(job.skills ?? []).join(" ")} ${job.welfare?.join?.(" ") ?? ""}`;
	const jobTerms = terms(jobText);
	const resumeTerms = new Set([
		...terms((resume?.skills ?? []).join(" ")),
		...terms(resume?.summary ?? ""),
		...terms((resume?.experience ?? []).map((e) => `${e.company} ${e.title} ${(e.highlights ?? []).join(" ")}`).join(" ")),
		...terms(resume?.rawText ?? ""),
	]);
	const matched = [...jobTerms].filter((t) => resumeTerms.has(t));
	// 只把"看起来像技能/要求"的缺口报出来，避免把 JD 里所有中文片段都当缺口
	const missing = [...jobTerms].filter((t) => !resumeTerms.has(t) && /^[a-z][a-z0-9+.#-]+$/u.test(t)).slice(0, 8);
	const ratio = jobTerms.size === 0 ? 0 : matched.length / jobTerms.size;
	return { score: Math.round(ratio * 100), matched, missing, jobTermCount: jobTerms.size };
}

/** 经历里与 JD 最贴的一条亮点，用来当话术里的"实据"。 */
function bestHighlight(resume, job) {
	const jobTerms = terms(`${job.title ?? ""} ${job.jd ?? ""}`);
	let best = { text: "", hit: 0 };
	for (const e of resume?.experience ?? []) {
		for (const h of e.highlights ?? []) {
			const hit = [...terms(h)].filter((t) => jobTerms.has(t)).length;
			if (hit > best.hit) best = { text: h, hit };
		}
	}
	return best.text;
}

/**
 * 生成打招呼话术。
 * @returns {{text: string, matched: string[], missing: string[], reasons: string[], length: number}}
 */
export function buildGreeting({ resume, job, profile = {}, maxChars = 180 } = {}) {
	const m = matchResumeToJob(resume, job);
	const yoe = resume?.yoe ?? null;
	const title = job?.title ?? "这个岗位";
	const company = job?.company ?? "贵司";
	const reasons = [];

	// 只挑"简历里真有"的技能，且必须出现在 JD 里 —— 命中集合天然满足这两点
	const skills = (resume?.skills ?? []).filter((s) => m.matched.includes(s.toLowerCase())).slice(0, 3);
	if (skills.length > 0) reasons.push(`技能命中：${skills.join("/")}`);
	const highlight = bestHighlight(resume, job);
	if (highlight !== "") reasons.push("经历命中：用与 JD 重合度最高的那条亮点");

	const parts = [];
	parts.push(`您好，看到${company}在招${title}。`);
	if (yoe !== null) parts.push(`我有 ${yoe} 年开发经验，`);
	else parts.push("我一直在做相关方向，");
	if (skills.length > 0) parts.push(`主要技术栈是 ${skills.join("、")}，`);
	if (highlight !== "") parts.push(`${highlight.replace(/[。；;]$/u, "")}，`);
	parts.push("和岗位要求比较契合，想和您详细聊聊，方便的话我把详细简历发您。");

	let text = parts.join("").replace(/，。/gu, "。").replace(/，，/gu, "，");
	if (text.length > maxChars) {
		// 超长就砍掉经历那句（技能比经历更硬）
		const trimmed = [`您好，看到${company}在招${title}。`];
		if (yoe !== null) trimmed.push(`我有 ${yoe} 年开发经验，`);
		if (skills.length > 0) trimmed.push(`技术栈是 ${skills.join("、")}，`);
		trimmed.push("与岗位要求契合，想和您聊聊。");
		text = trimmed.join("");
	}
	return { text, matched: m.matched.slice(0, 12), missing: m.missing, score: m.score, reasons, length: text.length };
}

/**
 * 发送打招呼 / 发起会话。契约来自两个参考实现的交集：
 *   - boss-agent-cli `BossClient.greet()`：**POST** form
 *       `securityId`, `jobId`, `greeting`（greeting 就是用户改过的那段话术）
 *   - zhipin-geek `BossClient.add_friend()`：`securityId` + `lid`
 *
 * 两者都指向同一个路径 `/wapi/zpgeek/friend/add.json`，差别是参数名。
 * 这里**一次请求把四个都带上**（securityId / jobId / lid / greeting）：
 * 服务端取它认的那几个，不认的忽略。仍然只发一次 —— 不做"先 GET 再 POST"
 * 那种在 Boss 眼里等于两次请求的补救。
 *
 * ⚠️ 上一版是 `GET ?securityId=&jobId=` 且**完全丢掉了 greeting**：
 * 用户在输入框里改的话术根本没进过请求体，发出去的永远是服务端默认招呼语。
 * 这是本次修掉的 bug 之一。
 *
 * 风控码 35 / 登录态失效会原样报出来，不吞。
 */
export async function sendGreeting(_session, { securityId, jobId, lid = "", text = "", referer } = {}) {
	if (!securityId) return { ok: false, error: "缺少 securityId（打招呼必须用列表条目里那一个）" };
	if (!jobId && !lid) return { ok: false, error: "缺少 jobId / lid，无法定位要打招呼的岗位" };
	let r;
	try {
		const linked = await connectExistingBossBrowser();
		if (!linked.loggedIn) return { ok: false, error: "现有 Chrome 的 Boss 登录态已失效", loggedOut: true };
		const body = { securityId, greeting: text };
		if (jobId) body.jobId = jobId;
		if (lid) body.lid = lid;
		r = await browserJson(linked.page, "/wapi/zpgeek/friend/add.json", {}, {
			method: "POST",
			body,
			form: true,
			referer: referer ?? "https://www.zhipin.com/web/geek/job",
		});
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
	const state = classifyBossResponse(r.json, r);
	if (state.kind !== "success") {
		if (["ip-risk", "account-risk", "environment-risk", "browser-blocked", "rate-limited"].includes(state.kind)) markCooldown({ kind: state.kind, message: `打招呼终止：${r.json?.message ?? state.kind}` });
		return { ok: false, error: r.json?.message ?? state.kind, flagged: state.kind.includes("risk") || state.kind === "browser-blocked", loggedOut: state.kind === "logged-out" };
	}
	return { ok: true, data: r.json?.zpData ?? {}, raw: r.json };
}
