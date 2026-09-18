/**
 * 用模型写"待发送的句子"。
 *
 * 这个功能的边界，用户说得很清楚：
 *   - 模型**只负责生成一句话**，不负责跟 HR 聊；
 *   - 句子进输入框给人看，**人按发送**才真的发出去；
 *   - 发出去之后能读到 HR 的回复，再生成下一句。
 *
 * 所以这里刻意只做一件事：给定「JD + 我的结构化简历 + 当前会话」，产出几条候选句子。
 * 它**不碰**发送（在 `boss/messages.mjs` 的 `sendReply`）、不碰风控闸门、不自动循环。
 *
 * 为什么放宿主半边：key 不能下发到浏览器，而且浏览器直连 api.deepseek.com 会被 CORS 挡。
 * key 复用 `boss/balance.mjs` 里那套解析（credentials 服务优先，退回 .credentials.yaml）。
 *
 * 没有 key / 请求失败 / 模型吐的不是 JSON —— 一律**退回规则模板**，并且在结果里
 * 标 `engine: "rules"` 和原因。降级必须让用户看得见，不能假装是模型写的。
 */
import { resolveApiKey } from "./balance.mjs";

export const LLM_ENDPOINT = "https://api.deepseek.com/chat/completions";
export const DEFAULT_MODEL = process.env.BOSS_LLM_MODEL ?? "deepseek-chat";
const TIMEOUT_MS = Number(process.env.BOSS_LLM_TIMEOUT_MS ?? 60000);
/** 单条草稿的字数上限。太长的招呼语 HR 不会看，也不像人写的。 */
export const MAX_DRAFT_CHARS = 120;

export const SYSTEM_PROMPT = [
	"你是求职者的回信助手。你只写「求职者要发给 HR 的那一句话」，不替求职者做任何决定。",
	"硬性要求：",
	"1. 只使用给定的简历事实。绝对不许编造经历、技能、公司、头衔、项目或任何数字。",
	"2. 不许承诺：薪资底线、入职时间、面试时间、offer 条件，都不许替求职者拍板；需要确认的一律写成提问。",
	"3. 语气像真人发微信，简洁、礼貌、不谄媚、不用敬语堆砌、不加 emoji、不用 Markdown。",
	`4. 每条草稿不超过 ${MAX_DRAFT_CHARS} 个汉字，直接给可以原样发送的正文。`,
	"5. 只返回 JSON，不要任何解释或代码块标记。",
].join("\n");

/** 输出结构。刻意和 boss-agent-cli 的 CHAT_REPLY_PROMPT 对齐，便于对照与替换。 */
export const OUTPUT_SCHEMA = `{
  "stage": "new|reply-needed|interview|salary|resume|waiting 之一",
  "intent": "对方最新一句在问什么，一句话",
  "drafts": [{ "style": "简洁专业|热情积极|谨慎确认", "text": "可直接发送的正文" }],
  "keyPoints": ["这条回复要覆盖的点"],
  "avoid": ["这条回复里不要出现的东西"]
}`;

/** 把结构化简历压成一段给模型的文字 —— 只放事实，不放姓名/电话/邮箱。 */
export function resumeToPromptText(resume) {
	if (resume === null || resume === undefined) return "（没有可用简历）";
	const lines = [];
	if (resume.yoe !== null && resume.yoe !== undefined) lines.push(`工作年限：${resume.yoe} 年`);
	if (resume.degree) lines.push(`学历：${resume.degree}`);
	if (Array.isArray(resume.skills) && resume.skills.length > 0) lines.push(`技能：${resume.skills.join("、")}`);
	if (resume.summary) lines.push(`自我描述：${resume.summary}`);
	for (const item of resume.experience ?? []) {
		const head = [item.company, item.title, item.period].filter(Boolean).join(" / ");
		lines.push(`经历${head ? `（${head}）` : ""}：`);
		for (const highlight of item.highlights ?? []) lines.push(`  - ${highlight}`);
	}
	return lines.length === 0 ? "（简历里没有可用的结构化事实）" : lines.join("\n");
}

/** 会话压成"谁说了什么"的文本，最近 20 条封顶。 */
export function messagesToPromptText(messages) {
	const list = (messages ?? []).slice(-20);
	if (list.length === 0) return "（还没有任何聊天记录）";
	return list.map((m) => `${m.direction === "incoming" ? "HR" : "我"}：${String(m.text ?? "").slice(0, 300)}`).join("\n");
}

/** 组装 user 消息。可单独测试：断言"该带的信息都带上了"。 */
export function buildUserPrompt({ job, resume, messages, tone = "" }) {
	return [
		"# 目标岗位",
		`职位：${job?.title ?? "（未知）"}`,
		`公司：${job?.company ?? "（未知）"}`,
		`薪资：${job?.salary ?? "（未写）"}`,
		"",
		"## JD 全文",
		String(job?.jd ?? "").slice(0, 4000) || "（列表接口没给 JD 正文）",
		"",
		"# 我的简历（唯一可用的事实来源）",
		resumeToPromptText(resume),
		"",
		"# 当前会话（最近 20 条，HR 是对方）",
		messagesToPromptText(messages),
		"",
		tone ? `# 语气要求\n${tone}` : "",
		"",
		"# 任务",
		"判断对方最新一句是什么意思，然后写 2-3 条候选回复。",
		"如果最新一条是对方发的、且需要我回应，就针对它写；如果最新的已经在等对方，就写一条有分寸的跟进。",
		"",
		"# 输出",
		OUTPUT_SCHEMA,
	].filter((part) => part !== "").join("\n");
}

/** 模型经常把 JSON 包在 ``` 里，或者前后带一句话。剥出来。 */
export function parseDrafts(content) {
	if (typeof content !== "string") return null;
	let text = content.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text);
	if (fence !== null) text = fence[1].trim();
	try {
		return JSON.parse(text);
	} catch { /* 继续尝试截取第一个对象 */ }
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** 把模型输出规整成界面能直接用的形状；形状不对就返回 null（让上层降级）。 */
export function normalizeDrafts(parsed, { maxChars = MAX_DRAFT_CHARS } = {}) {
	if (parsed === null || typeof parsed !== "object") return null;
	const raw = Array.isArray(parsed.drafts) ? parsed.drafts : [];
	const drafts = [];
	for (const item of raw) {
		const text = typeof item === "string" ? item : item?.text;
		if (typeof text !== "string") continue;
		const trimmed = text.trim().replace(/\s*\n+\s*/gu, " ");
		if (trimmed === "") continue;
		drafts.push({
			style: (typeof item === "object" && item?.style) ? String(item.style) : (drafts.length === 0 ? "简洁专业" : "谨慎确认"),
			text: trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed,
			from: "model",
		});
		if (drafts.length >= 3) break;
	}
	if (drafts.length === 0) return null;
	return {
		stage: typeof parsed.stage === "string" && parsed.stage !== "" ? parsed.stage : null,
		intent: typeof parsed.intent === "string" ? parsed.intent : "",
		drafts,
		keyPoints: (Array.isArray(parsed.keyPoints) ? parsed.keyPoints : []).filter((x) => typeof x === "string").slice(0, 6),
		avoid: (Array.isArray(parsed.avoid) ? parsed.avoid : []).filter((x) => typeof x === "string").slice(0, 6),
	};
}

/**
 * 调模型写草稿。任何一步失败都返回 `{ ok: false, reason, error }`，由调用方决定降级。
 * @param {{ job: object, resume: object, messages: object[], tone?: string, ctx?: object, fetchImpl?: Function, model?: string }} input
 */
export async function draftWithLlm({ job, resume, messages, tone = "", ctx = null, fetchImpl = null, model = DEFAULT_MODEL } = {}) {
	const doFetch = fetchImpl ?? globalThis.fetch;
	const { key, from } = await resolveApiKey(ctx);
	if (key === null) return { ok: false, reason: "no-key", error: "没找到 DeepSeek API key（credentials 服务与 ~/.dsh/.credentials.yaml 都没有）" };
	if (typeof doFetch !== "function") return { ok: false, reason: "no-fetch", error: "当前运行时没有 fetch" };

	const controller = typeof AbortController === "function" ? new AbortController() : null;
	const timer = controller === null ? null : setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await doFetch(LLM_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: buildUserPrompt({ job, resume, messages, tone }) },
				],
				// 写句子不需要创造性，低温度更不容易编经历
				temperature: 0.4,
				max_tokens: 900,
				response_format: { type: "json_object" },
			}),
			...(controller === null ? {} : { signal: controller.signal }),
		});
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* 非 JSON 错误页 */ }
		if (!res.ok) return { ok: false, reason: "http", error: `HTTP ${res.status} ${json?.error?.message ?? text.slice(0, 160)}` };
		const content = json?.choices?.[0]?.message?.content ?? "";
		const normalized = normalizeDrafts(parseDrafts(content));
		if (normalized === null) return { ok: false, reason: "parse", error: `模型没有返回可用的 JSON 草稿：${String(content).slice(0, 160)}` };
		return { ok: true, ...normalized, model, keyFrom: from, usage: json?.usage ?? null };
	} catch (err) {
		const aborted = err?.name === "AbortError";
		return { ok: false, reason: aborted ? "timeout" : "network", error: aborted ? `模型请求超时（${TIMEOUT_MS}ms）` : `模型请求失败：${String(err?.message ?? err)}` };
	} finally {
		if (timer !== null) clearTimeout(timer);
	}
}

/** 把模型结果和规则结果合成一份给界面用的建议。 */
export function mergeAdvice(rules, ai) {
	if (ai === null || ai.ok !== true) {
		return { ...rules, engine: "rules", engineError: ai?.error ?? null, engineReason: ai?.reason ?? null };
	}
	return {
		...rules,
		// 模型判定不了阶段就用规则的
		stage: ai.stage ?? rules.stage,
		intent: ai.intent || rules.intent,
		drafts: ai.drafts,
		// 两边的要点/禁忌都留下：规则那几条是硬约束，模型那几条是这次针对性的
		keyPoints: [...new Set([...(ai.keyPoints ?? []), ...(rules.keyPoints ?? [])])],
		avoid: [...new Set([...(ai.avoid ?? []), ...(rules.avoid ?? [])])],
		engine: "model",
		model: ai.model ?? null,
		usage: ai.usage ?? null,
		engineError: null,
		engineReason: null,
	};
}
