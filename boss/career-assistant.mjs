import { join } from "node:path";
import { DATA_DIR, readJson, writeJson } from "./lib.mjs";
import { readIndex, safeName } from "./resumes.mjs";
import { summarizeConversation } from "./messages.mjs";

const KEYWORDS = [
	"Java", "Spring Boot", "Spring Cloud", "Spring", "MyBatis", "MySQL", "PostgreSQL", "Redis", "Kafka", "RocketMQ",
	"Elasticsearch", "MongoDB", "Docker", "Kubernetes", "K8s", "Linux", "Nginx", "Dubbo", "Python", "Go", "Golang",
	"Node.js", "TypeScript", "JavaScript", "React", "Vue", "C++", "Rust", "Flink", "Spark", "Hadoop", "ClickHouse",
	"TensorFlow", "PyTorch", "LLM", "RAG", "微服务", "分布式", "高并发", "性能优化", "消息队列", "分库分表",
	"DevOps", "CI/CD", "Prometheus", "Grafana", "AWS", "阿里云", "SQL", "NoSQL", "gRPC", "RESTful", "WebSocket", "JVM", "多线程",
];
const uniq = (items) => [...new Set(items.filter(Boolean))];

export function extractJobKeywords(job) {
	const text = `${job?.title ?? ""}\n${job?.jd ?? ""}`.toLowerCase();
	return KEYWORDS.filter((keyword) => text.includes(keyword.toLowerCase()));
}

/** 技能列表 + 摘要，拼成一段便于对照的文本。 */
function skillsLine(skills, summary) {
	return [skills?.length ? `技能：${skills.join("、")}` : null, summary || null].filter(Boolean).join("\n");
}

/** 规则版定制：只重排/强调简历已有事实，绝不把 JD 中缺失技能写成“已掌握”。 */
export function tailorStructuredResume(structured, job) {
	const jdKeywords = extractJobKeywords(job);
	const originalSkills = structured?.skills ?? [];
	const matched = originalSkills.filter((skill) => jdKeywords.some((keyword) => keyword.toLowerCase() === skill.toLowerCase() || keyword.toLowerCase().includes(skill.toLowerCase()) || skill.toLowerCase().includes(keyword.toLowerCase())));
	const remaining = originalSkills.filter((skill) => !matched.includes(skill));
	const gaps = jdKeywords.filter((keyword) => !originalSkills.some((skill) => keyword.toLowerCase() === skill.toLowerCase() || keyword.toLowerCase().includes(skill.toLowerCase()) || skill.toLowerCase().includes(keyword.toLowerCase())));
	const experience = (structured?.experience ?? []).map((item) => ({
		...item,
		highlights: [...(item.highlights ?? [])].sort((a, b) => {
			const score = (text) => matched.filter((skill) => String(text).toLowerCase().includes(skill.toLowerCase())).length;
			return score(b) - score(a);
		}),
	}));
	const identity = [structured?.yoe ? `${structured.yoe} 年经验` : null, structured?.degree || null].filter(Boolean).join("、");
	const focus = matched.slice(0, 5).join("、");
	const summary = [identity, focus ? `核心技能：${focus}` : null, `目标岗位：${job?.title ?? ""}`].filter(Boolean).join("；");
	return {
		jobId: job?.id ?? "",
		jobTitle: job?.title ?? "",
		resume: { ...structured, skills: [...matched, ...remaining], experience, summary: summary || structured?.summary || "" },
		matchedKeywords: matched,
		gaps,
		changes: [matched.length ? `把与 JD 匹配的技能前置：${matched.join("、")}` : "当前简历未识别出与 JD 直接匹配的技能", "把包含匹配技能的经历要点前置", "生成针对该岗位的摘要，原始经历不变"],
		warnings: gaps.length ? [`JD 还要求 ${gaps.join("、")}；简历没有证据，不应写进简历，需人工确认真实经历后再补。`] : [],
		// 给界面直接渲染的「改了什么」：每段都有 before → after，便于逐段核对，
		// 而不是只给一句"已按 JD 优化"。
		polishedSections: [
			{ section: "技能", original: skillsLine(originalSkills, ""), polished: skillsLine([...matched, ...remaining], ""), changes: matched.length ? [`${matched.join("、")} 前置`] : [] },
			{ section: "个人摘要", original: structured?.summary ?? "", polished: summary || structured?.summary || "", changes: ["按目标岗位重写摘要，只复用简历里已有的事实"] },
			{ section: "经历要点", original: (structured?.experience ?? []).map((item) => (item.highlights ?? []).join("｜")).join("\n"), polished: experience.map((item) => (item.highlights ?? []).join("｜")).join("\n"), changes: ["与 JD 命中关键词的要点排在前面"] },
		],
		generalSuggestions: [
			matched.length ? `把「${matched.slice(0, 3).join("、")}」放进摘要和第一段经历的第一条要点，HR 十秒内就能看到` : "先补一条与 JD 最相关的经历要点",
			gaps.length ? `缺口 ${gaps.join("、")} 不要写成已掌握；如果确实做过，补上项目背景和你的具体动作` : "技能覆盖已经比较全，重点改成写结果和数字",
			"每条经历尽量写成「做了什么 → 用什么技术 → 拿到什么结果」，数字必须是真实的",
		],
		keywordAdditions: matched,
	};
}

export function buildReplyAdvice({ job, resume, messages }) {
	const summary = summarizeConversation(messages);
	const matched = (resume?.skills ?? []).filter((skill) => extractJobKeywords(job).some((keyword) => keyword.toLowerCase().includes(skill.toLowerCase()) || skill.toLowerCase().includes(keyword.toLowerCase()))).slice(0, 3);
	const latestIncoming = [...(messages ?? [])].reverse().find((message) => message.direction === "incoming")?.text ?? "";
	let drafts;
	if (summary.stage === "interview") {
		drafts = [
			"您好，感谢邀请。明天下午我可以参加面试，方便告知具体时间、面试形式和预计时长吗？",
			"您好，可以的。麻烦确认下面试时间、线上/线下形式，以及是否需要提前准备材料，谢谢。",
		];
	} else if (summary.stage === "salary") {
		drafts = [
			`您好，我关注到该岗位薪资范围是${job?.salary ?? "待确认"}。希望先结合职责、级别和整体待遇进一步沟通，再确认具体期望。`,
			"您好，薪资可以沟通。我更希望结合岗位职责、面试评估和整体福利综合确认，方便先了解一下岗位级别吗？",
		];
	} else if (summary.stage === "resume") {
		drafts = [
			`您好，可以的。我会提供针对「${job?.title ?? "该岗位"}」整理的简历；其中与岗位较匹配的是${matched.join("、") || "相关项目经历"}。`,
			"您好，简历可以发送。为便于您判断匹配度，我也可以补充说明与岗位要求最相关的项目经历。",
		];
	} else if (summary.needsReply) {
		drafts = [
			`您好，感谢联系。我对「${job?.title ?? "这个岗位"}」感兴趣，${matched.length ? `我的${matched.join("、")}经验与岗位要求比较匹配，` : ""}想进一步了解团队和具体职责。`,
			"您好，收到。方便介绍一下当前岗位最优先解决的问题，以及面试流程和后续安排吗？",
		];
	} else {
		drafts = ["对方暂无新的待回复消息，建议先等待，避免连续追问。", "如超过约定时间仍无回复，可简短跟进一次并提供新的有效信息。"];
	}
	return {
		stage: summary.stage,
		needsReply: summary.needsReply,
		intent: latestIncoming || "对方暂无新的待回复消息",
		context: { jobTitle: job?.title ?? "", company: job?.company ?? "", resumeName: resume?.name ?? "", resumeSkills: resume?.skills ?? [], messageCount: messages?.length ?? 0 },
		drafts: drafts.map((text, index) => ({ style: index === 0 ? "简洁专业" : "谨慎确认", text })),
		keyPoints: uniq([matched.length ? `可证实的匹配技能：${matched.join("、")}` : null, summary.stage === "interview" ? "确认时间、形式、时长" : null, summary.needsReply ? "回应对方最新问题" : "避免无意义追问"]),
		avoid: ["不要虚构简历中不存在的经历、技能或数字", "不要在未确认前承诺入职时间、薪资底线或面试安排"],
	};
}

const jobsFile = () => readJson(join(DATA_DIR, "jobs.json"), { jobs: [] }) ?? { jobs: [] };

export function tailorResumeForJob(jobId, resumeName) {
	const job = (jobsFile().jobs ?? []).find((item) => item.id === jobId || item.encryptJobId === jobId);
	if (!job) return { ok: false, error: `岗位 ${jobId} 不在岗位库里` };
	const index = readIndex();
	const candidates = (index?.files ?? []).filter((file) => file.status === "parsed");
	const file = candidates.find((item) => item.name === resumeName) ?? candidates.find((item) => item.name === index?.defaultResume) ?? candidates[0];
	if (!file) return { ok: false, error: "简历库里没有解析成功的简历" };
	const tailored = tailorStructuredResume(file.structured, job);
	const storePath = join(DATA_DIR, "tailored-resumes.json");
	const store = readJson(storePath, { version: 1, items: [] }) ?? { version: 1, items: [] };
	const item = { id: `${job.id}:${safeName(file.name)}`, jobId: job.id, sourceResume: file.name, createdAt: new Date().toISOString(), ...tailored };
	const items = [item, ...(store.items ?? []).filter((entry) => entry.id !== item.id)].slice(0, 200);
	writeJson(storePath, { version: 1, updatedAt: item.createdAt, items });
	return { ok: true, item };
}

export function createReplyAdvice(jobId, resumeName, conversation) {
	const job = (jobsFile().jobs ?? []).find((item) => item.id === jobId || item.encryptJobId === jobId);
	if (!job) return { ok: false, error: `岗位 ${jobId} 不在岗位库里` };
	const index = readIndex();
	const candidates = (index?.files ?? []).filter((file) => file.status === "parsed");
	const file = candidates.find((item) => item.name === resumeName) ?? candidates.find((item) => item.name === index?.defaultResume) ?? candidates[0];
	if (!file) return { ok: false, error: "简历库里没有解析成功的简历" };
	return { ok: true, advice: buildReplyAdvice({ job, resume: file.structured, messages: conversation?.messages ?? [] }) };
}
