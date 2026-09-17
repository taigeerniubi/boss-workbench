/**
 * 解析层的自检：自己造 fixture，因为手上没有真简历。
 *   - 一个真 zip 结构的 .docx（zlib deflate + 中央目录）
 *   - 一个带 ToUnicode CMap 的 .pdf（中文简历的真实编码方式：hex + CMap）
 *   - 一个纯文本简历
 * 用法： node boss/parse.test.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseResumeFile } from "./parse.mjs";

// 造出来的 fixture 进系统临时目录 —— 测试不该往用户的 ~/.dsh 里写东西
const FIX = join(tmpdir(), "boss-workbench-fixtures");
mkdirSync(FIX, { recursive: true });

//#region 造一个真正的 .docx
function buildDocx(paragraphs) {
	const esc = (s) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
	const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join("");
	const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
	const files = [
		{ name: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', "utf8") },
		{ name: "word/document.xml", data: Buffer.from(document, "utf8") },
	];
	const locals = [];
	const central = [];
	let offset = 0;
	for (const f of files) {
		const comp = deflateRawSync(f.data);
		const nameBuf = Buffer.from(f.name, "utf8");
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(8, 8); // deflate
		lh.writeUInt32LE(0, 14); // crc（读取端不校验）
		lh.writeUInt32LE(comp.length, 18);
		lh.writeUInt32LE(f.data.length, 22);
		lh.writeUInt16LE(nameBuf.length, 26);
		locals.push(lh, nameBuf, comp);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt16LE(8, 10);
		ch.writeUInt32LE(comp.length, 20);
		ch.writeUInt32LE(f.data.length, 24);
		ch.writeUInt16LE(nameBuf.length, 28);
		ch.writeUInt32LE(offset, 42);
		central.push(ch, nameBuf);
		offset += 30 + nameBuf.length + comp.length;
	}
	const cd = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, eocd]);
}
//#endregion

//#region 造一个带 ToUnicode CMap 的 .pdf（中文简历的真实编码）
function buildPdf(codes) {
	// codes: [[code, 汉字], ...] —— 走 CID + CMap 这条路，就是真中文 PDF 的样子
	const bfchar = codes.map(([c, ch]) => `<${c.toString(16).padStart(4, "0")}> <${ch.codePointAt(0).toString(16).padStart(4, "0")}>`).join("\n");
	const cMap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${codes.length} beginbfchar\n${bfchar}\nendbfchar\nendcmap\nend`;
	const content = `BT /F1 12 Tf 72 720 Td <${codes.map(([c]) => c.toString(16).padStart(4, "0")).join("")}> Tj ET`;
	const objs = [
		"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
		"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
		"3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
		"4 0 obj << /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >> endobj",
		`5 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`,
		`6 0 obj << /Length ${cMap.length} >>\nstream\n${cMap}\nendstream\nendobj`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [];
	for (const o of objs) {
		offsets.push(pdf.length);
		pdf += o + "\n";
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return Buffer.from(pdf, "latin1");
}
//#endregion

const TXT = `张伟
后端工程师
手机：13812345678    邮箱：zhangwei@example.com
求职意向：后端工程师 / 高级开发工程师
期望城市：北京

教育经历
2015.09 - 2019.06  某某大学  计算机科学与技术  本科

工作经历
2021.03 - 至今  中科智联科技有限公司  后端工程师
负责核心交易系统后端设计与开发，日均千万级订单
主导服务拆分，QPS 从 3k 提升到 12k
参与分库分表与消息队列改造

2019.07 - 2021.02  某某网络科技有限公司  后端开发工程师
负责订单中心接口开发

技能
Java / Spring Boot / Spring Cloud / MySQL / Redis / Kafka / Docker / Kubernetes
熟悉 分布式、高并发、性能优化
`;

const docxPath = join(FIX, "sample-resume.docx");
const pdfPath = join(FIX, "sample-resume.pdf");
const txtPath = join(FIX, "sample-resume.md");
writeFileSync(docxPath, buildDocx(TXT.split("\n").filter((l) => l.trim() !== "")));
writeFileSync(pdfPath, buildPdf([
	[1, "张"], [2, "三"], [3, "J"], [4, "a"], [5, "v"], [6, "a"], [7, "后"], [8, "端"],
	[9, "1"], [10, "3"], [11, "8"], [12, "1"], [13, "2"], [14, "3"], [15, "4"], [16, "5"], [17, "6"], [18, "7"], [19, "8"],
]));
writeFileSync(txtPath, TXT, "utf8");

const fail = [];
const check = (ok, msg) => {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`);
	if (!ok) fail.push(msg);
};

console.log(`fixtures: ${FIX}\n`);
for (const [label, p] of [["docx", docxPath], ["pdf", pdfPath], ["markdown", txtPath]]) {
	console.log(`── ${label} ──`);
	const r = parseResumeFile(p, { keepRaw: false });
	if (!r.ok) {
		console.log(`  ✗ 解析失败: ${r.error}  warnings=${JSON.stringify(r.warnings ?? [])}`);
		fail.push(`${label} 解析失败`);
		continue;
	}
	const s = r.structured;
	console.log(`  kind=${r.kind}  抽取 ${s.chars} 字  警告=${JSON.stringify(r.warnings)}`);
	console.log(`  姓名=${s.name || "(空)"}  手机=${s.phone || "(空)"}  邮箱=${s.email || "(空)"}  城市=${s.city || "(空)"}`);
	console.log(`  学历=${s.degree || "(空)"}  年限=${s.yoe ?? "(空)"}  seniority=${s.seniority || "(空)"}`);
	console.log(`  技能(${s.skills.length})=${s.skills.slice(0, 8).join(", ")}`);
	console.log(`  期望岗位=${JSON.stringify(s.targetTitles)}  经历段=${s.experience.length}`);
	if (label !== "pdf") {
		// pdf fixture 只有一个字符串，不测这些字段
		check(s.phone === "13812345678", `${label}: 手机号`);
		check(s.email === "zhangwei@example.com", `${label}: 邮箱`);
		check(s.city === "北京", `${label}: 城市`);
		check(s.degree === "本科", `${label}: 学历`);
		check(s.yoe !== null && s.yoe > 3, `${label}: 工作年限算出来了（${s.yoe}）`);
		check(s.skills.includes("Java") && s.skills.includes("Redis") && s.skills.includes("Kafka"), `${label}: 技能词表命中`);
	} else {
		check(r.structured.chars >= 8, `pdf: 抽到 ${r.structured.chars} 字（hex + ToUnicode CMap 路径）`);
		check(!r.warnings.some((w) => w.includes("扫描件")), "pdf: 不会把带文字层的 PDF 误判成扫描件");
		check(r.structured.skills.includes("Java"), "pdf: 从 CMap 还原出的文本里认出了技能");
	}
}
console.log(`\n${fail.length === 0 ? "全部通过 ✅" : `${fail.length} 项失败 ❌`}`);
process.exit(fail.length === 0 ? 0 : 1);
