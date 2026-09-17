/**
 * 简历解析：文档 → 纯文本 → 结构化字段。
 *
 * 两条硬约束来自现实：
 *   1. **没有可用的解析库**。这台机器的 node_modules 里没有 pdfjs / mammoth / jszip，
 *      所以 docx 与 pdf 都是自己写的（docx 靠 zlib 解 zip，pdf 靠 zlib 解 FlateDecode 流）。
 *   2. **不上 OCR**。你的判断是对的：PDF / Word 都有文字层，OCR 只会引入错字。
 *      代价是扫描件（图片型 PDF）抽不出文字 —— 那种情况会明确告诉你，而不是编内容。
 *
 * 结构化字段是照 Cookd 那套"硬过滤标签"的思路选的：
 *   seniority / degree / yoe / location 用来做**硬条件过滤**，
 *   skills / experience 文本用来做**匹配打分**（将来接 embedding 就是这里的输入）。
 */
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";

//#region ZIP（.docx 就是一个 zip）
/**
 * 极简 zip 读取器：扫 End of Central Directory → 中央目录 → 取指定条目的原始字节。
 * 只支持 store(0) 与 deflate(8) —— docx 就是这两种，够用。
 */
function unzipEntries(buf) {
	// EOCD 签名 0x06054b50，从尾部往前找（注释最长 65535）
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd === -1) throw new Error("不是有效的 zip/docx（找不到 EOCD）");
	const count = buf.readUInt16LE(eocd + 10);
	let off = buf.readUInt32LE(eocd + 16);
	const entries = new Map();
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(off) !== 0x02014b50) break;
		const method = buf.readUInt16LE(off + 10);
		const compSize = buf.readUInt32LE(off + 20);
		const nameLen = buf.readUInt16LE(off + 28);
		const extraLen = buf.readUInt16LE(off + 30);
		const commentLen = buf.readUInt16LE(off + 32);
		const localOff = buf.readUInt32LE(off + 42);
		const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
		entries.set(name, { method, compSize, localOff });
		off += 46 + nameLen + extraLen + commentLen;
	}
	return {
		read(name) {
			const e = entries.get(name);
			if (e === undefined) return null;
			// 本地头长度与中央目录不同（各带自己的 name/extra），必须按本地头算数据起点
			const lNameLen = buf.readUInt16LE(e.localOff + 26);
			const lExtraLen = buf.readUInt16LE(e.localOff + 28);
			const start = e.localOff + 30 + lNameLen + lExtraLen;
			const raw = buf.subarray(start, start + e.compSize);
			return e.method === 0 ? raw : inflateRawSync(raw);
		},
		names: () => [...entries.keys()],
	};
}
//#endregion

//#region DOCX
const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s) => s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/gu, (m, g) => {
	if (g.startsWith("#x") || g.startsWith("#X")) return String.fromCodePoint(Number.parseInt(g.slice(2), 16));
	if (g.startsWith("#")) return String.fromCodePoint(Number.parseInt(g.slice(1), 10));
	return XML_ENTITIES[g] ?? m;
});

/** 从 word/document.xml 抽段落文本。表格里的单元格按行内拼接，段落按 \n 分隔。 */
function docxToText(buf) {
	const zip = unzipEntries(buf);
	const xml = zip.read("word/document.xml");
	if (xml === null) throw new Error("docx 里没有 word/document.xml（是不是 .doc 旧格式？）");
	const doc = xml.toString("utf8");
	return decodeXml(
		doc
			.replace(/<w:tab\b[^>]*\/>/gu, "\t")
			.replace(/<w:br\b[^>]*\/>/gu, "\n")
			.replace(/<\/w:p>/gu, "\n")
			.replace(/<\/w:tc>/gu, "\t")
			.replace(/<[^>]+>/gu, ""),
	)
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}
//#endregion

//#region PDF
/**
 * 极简 PDF 文本抽取。步骤：
 *   1. 把所有 stream…endstream 拿出来，FlateDecode 的解压；
 *   2. 从内容流里取 `(...) Tj` / `[...] TJ` 的字符串；
 *   3. 如果有 ToUnicode CMap，按 code → unicode 映射解出中文（CID 字体的关键）。
 *
 * ⚠️ 明确的能力边界：**扫描件（图片型 PDF）抽不出文字**；没有 ToUnicode 的
 * CID 字体也只能拿到乱码。两种情况都会在 warnings 里说清楚，不假装成功。
 */
function pdfStreams(buf) {
	const out = [];
	const marker = Buffer.from("stream", "latin1");
	let at = buf.indexOf(marker);
	while (at !== -1) {
		let start = at + marker.length;
		if (buf[start] === 0x0d) start++;
		if (buf[start] === 0x0a) start++;
		const end = buf.indexOf(Buffer.from("endstream", "latin1"), start);
		if (end === -1) break;
		let body = buf.subarray(start, end);
		// 只有 FlateDecode 是可解的（其余如 DCTDecode 是图片）
		const dictStart = Math.max(0, at - 600);
		const dict = buf.toString("latin1", dictStart, at);
		if (/\/FlateDecode/u.test(dict)) {
			try {
				body = inflateSync(body);
			} catch {
				/* 解不开就跳过这一段 */
			}
		}
		out.push({ dict, body });
		at = buf.indexOf(marker, end + 9);
	}
	return out;
}

/** 解析 ToUnicode CMap：bfchar / bfrange → code → 字符串。 */
function parseToUnicode(text) {
	const map = new Map();
	for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/gu) ?? []) {
		for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/gu)) {
			map.set(Number.parseInt(m[1], 16), hexToStr(m[2]));
		}
	}
	for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/gu) ?? []) {
		for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/gu)) {
			const lo = Number.parseInt(m[1], 16);
			const hi = Number.parseInt(m[2], 16);
			const base = Number.parseInt(m[3], 16);
			for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCodePoint(base + (c - lo)));
		}
	}
	return map;
}
const hexToStr = (hex) => {
	let s = "";
	for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
	return s;
};

function pdfToText(buf) {
	const streams = pdfStreams(buf);
	const warnings = [];
	// 先收集全文档的 ToUnicode 映射（同一份简历里不同字体 code 撞车的概率低）
	const cmap = new Map();
	for (const { body } of streams) {
		const t = body.toString("latin1");
		if (t.includes("beginbfchar") || t.includes("beginbfrange")) for (const [k, v] of parseToUnicode(t)) cmap.set(k, v);
	}
	let text = "";
	let hexChunks = 0;
	let sawTextOp = false;
	for (const { body } of streams) {
		const src = body.toString("latin1");
		if (!/(Tj|TJ|Td|TD|T\*)/u.test(src)) continue;
		sawTextOp = true;
		const pieces = [];
		// TJ 数组里的每一段，以及裸 Tj 字符串
		for (const m of src.matchAll(/\[([^\]]*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*Tj|<([0-9a-fA-F\s]+)>\s*Tj|(-?\d+(?:\.\d+)?)\s*(?:Td|TD)/gu)) {
			if (m[4] !== undefined) {
				// 换行/位移：纵向移动通常代表新行，这里一律当换行处理（过拆无害）
				pieces.push("\n");
				continue;
			}
			if (m[2] !== undefined) {
				pieces.push(m[2].replace(/\\([()\\])/gu, "$1"));
				continue;
			}
			// 两种 hex 载体：TJ 数组里的 <..>，以及裸的 <..> Tj
			const hexList = m[3] !== undefined ? [m[3]] : [...(m[1] ?? "").matchAll(/<([0-9a-fA-F\s]+)>/gu)].map((x) => x[1]);
			for (const raw of hexList) {
				const hex = raw.replace(/\s/gu, "");
				if (hex === "") continue;
				hexChunks++;
				let s = "";
				for (let i = 0; i + 4 <= hex.length; i += 4) {
					const code = Number.parseInt(hex.slice(i, i + 4), 16);
					s += cmap.get(code) ?? (cmap.size === 0 ? String.fromCharCode(code) : "");
				}
				pieces.push(s);
			}
		}
		text += pieces.join("");
	}
	text = text.replace(/\n{3,}/gu, "\n\n").replace(/[ \t]{2,}/gu, " ").trim();

	const cjk = (text.match(/[\u4e00-\u9fff]/gu) ?? []).length;
	if (!sawTextOp && streams.length > 0) {
		warnings.push("PDF 里没有任何文字绘制指令 —— 是扫描件/图片型 PDF（本工具不做 OCR，请导出 docx 或带文字层的 PDF）");
	} else if (text.length < 40) {
		warnings.push(`PDF 只抽到 ${text.length} 字 —— 文字可能在矢量路径或图片里（不做 OCR）`);
	} else if (hexChunks > 0 && cjk === 0 && cmap.size === 0) {
		warnings.push("PDF 用的是 CID 字体但没有 ToUnicode 映射，中文无法还原 —— 建议导出 docx");
	}
	return { text, warnings };
}
//#endregion

/** 抽纯文本。返回 { text, kind, warnings }。 */
export function extractText(filePath) {
	const ext = extname(filePath).toLowerCase();
	const buf = readFileSync(filePath);
	if (ext === ".docx") return { text: docxToText(buf), kind: "docx", warnings: [] };
	if (ext === ".pdf") {
		const r = pdfToText(buf);
		return { text: r.text, kind: "pdf", warnings: r.warnings };
	}
	if (ext === ".doc") {
		return { text: "", kind: "doc", warnings: [".doc 是旧二进制格式，本工具解不了 —— 请另存为 .docx"] };
	}
	if ([".md", ".txt", ".json", ".yaml", ".yml", ".html", ".htm"].includes(ext)) {
		const raw = buf.toString("utf8");
		return { text: ext.startsWith(".htm") ? decodeXml(raw.replace(/<[^>]+>/gu, "\n")) : raw, kind: "text", warnings: [] };
	}
	return { text: "", kind: "unknown", warnings: [`不认识的扩展名 ${ext}`] };
}

//#region 结构化字段
const DEGREE_ORDER = { 不限: 0, 大专: 1, 本科: 2, 硕士: 3, 博士: 4 };
const SKILL_VOCAB = [
	"Java", "Spring Boot", "Spring Cloud", "Spring", "MyBatis", "MySQL", "PostgreSQL", "Redis", "Kafka", "RocketMQ",
	"RabbitMQ", "Elasticsearch", "MongoDB", "Docker", "Kubernetes", "K8s", "Linux", "Nginx", "Dubbo", "Zookeeper",
	"Python", "Go", "Golang", "Node.js", "TypeScript", "JavaScript", "React", "Vue", "Flutter", "Android", "iOS",
	"C++", "C#", "PHP", "Rust", "Scala", "Spark", "Flink", "Hadoop", "Hive", "ClickHouse", "Doris", "Airflow",
	"TensorFlow", "PyTorch", "LLM", "RAG", "微服务", "分布式", "高并发", "性能优化", "消息队列", "分库分表",
	"DevOps", "CI/CD", "Jenkins", "Git", "Prometheus", "Grafana", "AWS", "阿里云", "腾讯云", "Kubernetes Operator",
	"单元测试", "领域驱动", "DDD", "SQL", "NoSQL", "gRPC", "RESTful", "WebSocket", "JVM", "多线程",
];

const uniq = (arr) => [...new Set(arr.filter((x) => x !== "" && x !== undefined))];
const pickAll = (text, re) => uniq([...text.matchAll(re)].map((m) => m[1] ?? m[0]));

/**
 * 文本 → 结构化简历。
 *
 * 这是**规则抽取**，不是 LLM。所以：
 *   - 每个字段带 confidence（命中与否），拿不准就留空，不猜；
 *   - `rawText` 原样保留，将来接 agent/embedding 时直接用全文，不必回头再解析。
 * 之所以先做规则版：它能离线测试、结果稳定、且不需要把简历发给第三方。
 */
export function parseResume(text, { sourceName = "" } = {}) {
	const lines = text.split(/\r?\n/u).map((l) => l.trim());
	const warnings = [];

	// 联系方式
	const phone = (/1[3-9]\d{9}/u.exec(text) ?? [])[0] ?? "";
	const email = (/[\w.+-]+@[\w-]+\.[\w.]+/u.exec(text) ?? [])[0] ?? "";
	const name = (lines.find((l) => /^[\u4e00-\u9fff]{2,4}$/u.test(l)) ?? "").trim();
	if (name === "") warnings.push("没认出姓名（正常，很多排版把姓名和标题写在一行）");

	// 学历
	const degree = ["博士", "硕士", "本科", "大专"].find((d) => text.includes(d)) ?? "";
	const degrees = pickAll(text, /(博士|硕士|本科|大专|MBA)/gu).filter((d) => d !== "MBA");

	// 工作年限：显式写了就用，否则用经历区间兜底
	let yoe = null;
	const explicit = /(\d+(?:\.\d+)?)\s*年(?:以上)?(?:工作)?经验/u.exec(text) ?? /工作年限[：:\s]*(\d+(?:\.\d+)?)/u.exec(text);
	if (explicit !== null) yoe = Number(explicit[1]);
	const years = [...text.matchAll(/(20\d{2})\s*[年.\-/]\s*(\d{1,2})?\s*[-~—至到]\s*(20\d{2}|至今|现在)/gu)];
	if (yoe === null && years.length > 0) {
		const now = new Date().getFullYear();
		let months = 0;
		for (const m of years) {
			const from = Number(m[1]) * 12 + (Number(m[2] ?? 1) || 1);
			const to = /至今|现在/u.test(m[3]) ? now * 12 + new Date().getMonth() + 1 : Number(m[3]) * 12;
			if (to > from) months += to - from;
		}
		if (months > 0) yoe = Math.round((months / 12) * 10) / 10;
	}

	// 城市
	const city = ["北京", "上海", "深圳", "广州", "杭州", "成都", "南京", "武汉", "西安", "苏州", "天津", "重庆", "长沙", "合肥", "郑州", "青岛", "厦门", "福州", "济南", "大连", "宁波", "无锡", "东莞", "佛山"].find((c) => text.includes(c)) ?? "";

	// 技能：词表命中（大小写不敏感，保留词表里的写法）
	const lower = text.toLowerCase();
	const skills = SKILL_VOCAB.filter((s) => lower.includes(s.toLowerCase()));

	// 经历：带公司/职位关键词的行
	const experience = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (!/公司|集团|科技|网络|信息|有限|银行|研究院|事业部/u.test(l)) continue;
		if (l.length > 60) continue;
		const range = /(20\d{2})\s*[年.\-/]?\s*(\d{1,2})?\s*[-~—至到]\s*(20\d{2}|至今|现在)/u.exec(l);
		experience.push({
			company: l.replace(/(20\d{2}).*$/u, "").replace(/[·|丨\-—]\s*$/u, "").trim(),
			period: range === null ? "" : range[0],
			title: (/[\u4e00-\u9fff]*?(工程师|开发|经理|架构师|主管|总监|专员|分析师|研究员)/u.exec(l) ?? [])[0] ?? "",
			highlights: lines.slice(i + 1, i + 4).filter((x) => x.length > 6 && x.length < 120).slice(0, 3),
		});
		if (experience.length >= 6) break;
	}

	// 目标岗位：从求职意向段或文件名的常见词里找
	const targetTitles = uniq([
		...pickAll(text, /(?:求职意向|期望职位|目标岗位|应聘职位)[：:\s]*([^\n，,。]{2,20})/gu),
		...SKILL_VOCAB.filter((s) => /Java|Go|Python|前端|后端|全栈|数据/iu.test(s)).slice(0, 2).map((s) => `${s} 工程师`),
	]);

	const confidence = {
		contact: phone !== "" || email !== "",
		degree: degree !== "",
		yoe: yoe !== null,
		city: city !== "",
		skills: skills.length >= 3,
	};
	if (!confidence.contact) warnings.push("没找到手机号/邮箱");
	if (!confidence.yoe) warnings.push("没算工作年限（文本里没有可识别的时间区间）");

	return {
		sourceName,
		name, phone, email, city,
		degree, degrees: uniq(degrees),
		yoe, yoeMin: yoe === null ? null : Math.max(0, Math.floor(yoe)), yoeMax: yoe === null ? null : Math.ceil(yoe),
		seniority: yoe === null ? "" : yoe < 1 ? "intern" : yoe < 3 ? "junior" : yoe < 6 ? "mid" : "senior",
		targetTitles,
		skills,
		experience,
		summary: lines.filter((l) => l.length > 20).slice(0, 3).join(" ").slice(0, 300),
		chars: text.length,
		confidence,
		warnings,
		rawText: text,
		parsedAt: new Date().toISOString(),
	};
}

/** 文件 → 结构化简历（parse.mjs 的唯一入口）。 */
export function parseResumeFile(filePath, { keepRaw = true } = {}) {
	if (!existsSync(filePath)) return { ok: false, error: "文件不存在", filePath };
	try {
		const { text, kind, warnings } = extractText(filePath);
		if (text.trim() === "") {
			return { ok: false, error: warnings[0] ?? "抽不出文字", kind, warnings, filePath };
		}
		const structured = parseResume(text, { sourceName: filePath });
		if (!keepRaw) delete structured.rawText;
		return { ok: true, kind, warnings, structured, filePath };
	} catch (err) {
		return { ok: false, error: String(err.message).split("\n")[0], filePath };
	}
}
//#endregion
