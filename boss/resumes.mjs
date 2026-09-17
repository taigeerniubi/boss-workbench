/**
 * 简历库：扫目录 → 抽文本 → 结构化 → 索引。
 *
 * 两层落盘，各司其职：
 *   `data/resume-text/<name>.txt`  ← 抽出来的纯文本，给 agent 读（按 JD 定制简历时要看全文）
 *   `data/resumes.json`            ← 结构化索引，给 UI 和筛选用（小、可整份塞进上下文）
 *
 * 解析结果按 (mtime, size) 缓存，所以重复扫描只处理变过的文件 ——
 * 上传多个简历时进度条才有意义（每个文件一次 parse，而不是每次重扫全库）。
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { extname, join } from "node:path";
import { DATA_DIR, RESUMES_DIR, ensureDirs, readJson, writeJson } from "./lib.mjs";
import { extractText, parseResume } from "./parse.mjs";

const DOC_EXT = new Set([".pdf", ".doc", ".docx", ".rtf", ".pages"]);
const TEXT_EXT = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".html", ".htm"]);
const MAX_DEPTH = 3;
const TEXT_DIR = () => join(DATA_DIR, "resume-text");
const CACHE_PATH = () => join(DATA_DIR, "resume-cache.json");

/** 文件名 → 可用于落盘的安全名（去掉路径分隔与奇怪字符）。 */
export const safeName = (name) => String(name).replace(/[\\/]/gu, "_").replace(/[^\w.\u4e00-\u9fff-]/gu, "_").slice(-120);

function walk(dir, depth = 0) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "resume-text") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (depth < MAX_DEPTH) out.push(...walk(full, depth + 1));
			continue;
		}
		out.push(full);
	}
	return out;
}

/** 从文件名 + 结构化结果猜这份简历的用途。 */
function classify(name, structured) {
	const lower = name.toLowerCase();
	if (/通用|general|base|master/u.test(lower)) return "base";
	if (/[_\-.](v\d+)|版本/u.test(lower)) return "tailored";
	if (structured !== null && structured.name !== "") return "tailored";
	return "other";
}

/**
 * 重建索引。
 * @param onProgress 每处理完一个文件回调一次（UI 的进度条就是它驱动的）
 */
export function buildIndex({ onProgress = null } = {}) {
	ensureDirs();
	if (!existsSync(TEXT_DIR())) mkdirSync(TEXT_DIR(), { recursive: true });
	const cache = readJson(CACHE_PATH(), {}) ?? {};
	const files = walk(RESUMES_DIR);
	const nextCache = {};
	const entries = [];

	files.forEach((full, i) => {
		const st = statSync(full);
		const ext = extname(full).toLowerCase();
		const name = full.slice(RESUMES_DIR.length + 1).replaceAll("\\", "/");
		const key = name;
		const fingerprint = `${st.mtimeMs}:${st.size}`;
		const base = {
			name,
			path: full,
			ext,
			bytes: st.size,
			modifiedAt: st.mtime.toISOString(),
			kind: DOC_EXT.has(ext) ? "document" : TEXT_EXT.has(ext) ? "text" : "unknown",
			parseable: DOC_EXT.has(ext) || TEXT_EXT.has(ext),
		};

		const hit = cache[key];
		if (hit !== undefined && hit.fingerprint === fingerprint) {
			entries.push({ ...base, ...hit.result });
			nextCache[key] = hit;
			if (onProgress !== null) onProgress({ index: i + 1, total: files.length, name, status: "cached" });
			return;
		}

		let result;
		try {
			const { text, kind, warnings } = extractText(full);
			const textPath = join(TEXT_DIR(), `${safeName(name)}.txt`);
			if (text.trim() !== "") writeFileSync(textPath, text, "utf8");
			if (text.trim() === "") {
				result = { status: "failed", error: warnings[0] ?? "抽不出文字", warnings, kind };
			} else {
				const structured = parseResume(text, { sourceName: name });
				delete structured.rawText; // 全文另有 textPath，索引保持小
				result = {
					status: "parsed",
					kind,
					warnings,
					textPath: textPath.slice(DATA_DIR.length + 1).replaceAll("\\", "/"),
					role: classify(name, structured),
					structured,
				};
			}
		} catch (err) {
			result = { status: "failed", error: String(err.message).split("\n")[0], warnings: [] };
		}
		entries.push({ ...base, ...result });
		nextCache[key] = { fingerprint, result };
		if (onProgress !== null) onProgress({ index: i + 1, total: files.length, name, status: result.status });
	});

	// 清掉已删除文件的缓存
	for (const k of Object.keys(cache)) if (nextCache[k] === undefined) delete nextCache[k];

	const parsedOk = entries.filter((e) => e.status === "parsed");
	const base = parsedOk.find((e) => e.role === "base") ?? parsedOk[0] ?? null;
	const index = {
		scannedAt: new Date().toISOString(),
		dir: RESUMES_DIR,
		count: entries.length,
		parsed: parsedOk.length,
		failed: entries.filter((e) => e.status === "failed").length,
		defaultResume: base === null ? null : base.name,
		files: entries,
	};
	writeJson(join(DATA_DIR, "resumes.json"), index);
	writeJson(CACHE_PATH(), nextCache);
	return index;
}

export const readIndex = () => readJson(join(DATA_DIR, "resumes.json"), null);

/** 保存上传上来的一个文件（原始字节），返回落盘路径。 */
export function saveUpload(fileName, bytes) {
	ensureDirs();
	const safe = safeName(fileName);
	const target = join(RESUMES_DIR, safe);
	writeFileSync(target, bytes);
	return target;
}

/** 删除一份简历（连同它的文本副本）。 */
export function removeResume(name) {
	const target = join(RESUMES_DIR, safeName(name));
	const textPath = join(TEXT_DIR(), `${safeName(name)}.txt`);
	let removed = false;
	if (existsSync(target)) {
		// name 里可能带子目录，safeName 已把分隔符换掉，所以再按原路径兜一次
		try {
			unlinkSync(target);
			removed = true;
		} catch { /* 落在子目录里的文件下面再试 */ }
	}
	if (!removed) {
		const raw = join(RESUMES_DIR, name);
		if (existsSync(raw) && raw.startsWith(RESUMES_DIR)) {
			rmSync(raw, { force: true });
			removed = true;
		}
	}
	if (existsSync(textPath)) rmSync(textPath, { force: true });
	return removed;
}

// 直接跑时才打印
if (process.argv[1] !== undefined && import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`) {
	const index = buildIndex({
		onProgress: ({ index: i, total, name, status }) => console.log(`  [${i}/${total}] ${status.padEnd(7)} ${name}`),
	});
	console.log(`\n目录: ${index.dir}`);
	console.log(`共 ${index.count} 份（成功解析 ${index.parsed}，失败 ${index.failed}）`);
	console.log(`默认基础简历: ${index.defaultResume ?? "（目录是空的，把简历丢进去再跑一次）"}`);
	for (const f of index.files) {
		if (f.status === "parsed") {
			const s = f.structured;
			console.log(`  ✓ ${f.name}   ${s.name || "?"} / ${s.degree || "?"} / ${s.yoe ?? "?"} 年 / 技能 ${s.skills.length} 项 / 城市 ${s.city || "?"}`);
		} else {
			console.log(`  ✗ ${f.name}   ${f.error}`);
		}
	}
	console.log(`\n索引: data/resumes.json   纯文本: data/resume-text/`);
}
