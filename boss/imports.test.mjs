/**
 * 静态检查所有本地 import 的名字**真的被导出**了吗。
 *
 * 为什么需要：`node --check` 只解析语法，**不解析 import 目标**。所以
 * `import { loadChromium } from "./lib.mjs"`（而它其实在 playwright.mjs 里）
 * 语法完全合法、check 通过、测试也过 —— 一直到用户真跑那个脚本才炸：
 *
 *     SyntaxError: The requested module './lib.mjs' does not provide an export named 'loadChromium'
 *
 * 这个 bug 真发生过（verify-browser.mjs），而且是用户跑出来的。所以补这道检查：
 * 纯静态读源码、算导出名，**不 import 任何东西** —— 因为 boss/ 下好些脚本
 * 一 import 就会执行（login-now 会开始登录、logout 会真的退出登录、scrape 会
 * process.exit），不能拿它们做运行时探测。
 *
 *   node boss/imports.test.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 把注释去掉再扫描。
 *
 * 必须有这一步：这个文件自己的注释里就写着那个反面例子
 * （`import { loadChromium } from "./lib.mjs"`），不去注释的话它会把自己的
 * 文档当成真代码来报错 —— 第一版就真这么报了。
 *
 * 用状态机而不是正则：得认得 `"https://…"` 里的 `//`，不能当成行注释切掉。
 */
function stripComments(src) {
	let out = "";
	let i = 0;
	let quote = null;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (quote !== null) {
			out += c;
			if (c === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (c === quote) quote = null;
			i++;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			quote = c;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** 收集要检查的文件：boss/ + plugin/lib/ + 仓库根的脚本。 */
function collect() {
	const out = [];
	for (const d of ["boss", "plugin/lib"]) {
		const abs = join(ROOT, d);
		if (!existsSync(abs)) continue;
		for (const f of readdirSync(abs)) if (f.endsWith(".mjs") || f.endsWith(".js")) out.push(join(abs, f));
	}
	for (const f of readdirSync(ROOT)) if (f.endsWith(".mjs")) out.push(join(ROOT, f));
	return out;
}

/**
 * 从源码里静态抽出导出名。
 * 覆盖 `export function/const/let/class`、`export { a, b as c }`、以及 `export * from "…"`（标记为"全都有"）。
 */
function exportsOf(src) {
	const names = new Set();
	let star = false;
	for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gmu)) names.add(m[1]);
	for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gmu)) {
		for (const part of m[1].split(",")) {
			const t = part.trim();
			if (t === "") continue;
			const as = /\bas\s+([A-Za-z_$][\w$]*)$/u.exec(t);
			names.add(as !== null ? as[1] : t.split(/\s+/u)[0]);
		}
	}
	if (/^\s*export\s+\*/gmu.test(src)) star = true;
	return { names, star };
}

/** 抽出一个文件里所有 `import { … } from "…"` 的具名导入。 */
function importsOf(src) {
	const out = [];
	const re = /import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/gu;
	for (const m of src.matchAll(re)) {
		const source = m[3];
		if (!source.startsWith(".")) continue; // 只查本地相对导入
		const clause = m[2];
		const names = [];
		if (clause !== undefined) {
			for (const part of clause.split(",")) {
				const t = part.trim();
				if (t === "") continue;
				// `foo as bar` 要的是**导出名** foo
				names.push(/\bas\s+([A-Za-z_$][\w$]*)$/u.test(t) ? t.split(/\s+as\s+/u)[0].trim() : t);
			}
		}
		out.push({ source, names, line: src.slice(0, m.index).split("\n").length });
	}
	return out;
}

const files = collect();
const cache = new Map();
const readCached = (p) => {
	if (!cache.has(p)) cache.set(p, existsSync(p) ? stripComments(readFileSync(p, "utf8")) : null);
	return cache.get(p);
};

const fail = [];
const check = (ok, msg) => {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`);
	if (!ok) fail.push(msg);
};

console.log(`检查 ${files.length} 个文件的本地 import\n`);

let checked = 0;
for (const file of files) {
	const src = readCached(file);
	if (src === null) continue;
	for (const imp of importsOf(src)) {
		const target = resolve(dirname(file), imp.source);
		const targetSrc = readCached(target);
		const rel = file.replace(ROOT + "\\", "").replace(ROOT + "/", "");
		if (targetSrc === null) {
			check(false, `${rel}:${imp.line} → ${imp.source} 这个文件不存在`);
			continue;
		}
		const { names, star } = exportsOf(targetSrc);
		if (star) continue; // export * —— 静态看不全，跳过
		for (const name of imp.names) {
			checked++;
			if (!names.has(name)) check(false, `${rel}:${imp.line} → ${imp.source} 没有导出 \`${name}\``);
		}
	}
}
console.log(`\n共检查 ${checked} 个具名导入`);
console.log(fail.length === 0 ? "全部通过 ✅" : `${fail.length} 项失败 ❌`);
process.exit(fail.length === 0 ? 0 : 1);
