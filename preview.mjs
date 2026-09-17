/**
 * 静态预览：把 client.js 的组件树渲染成独立 HTML，再交给 headless Chrome 截图。
 *
 * 为什么需要它：工作台挂在 DSH Web GUI 的 `main` 席位里，而那台服务器的 index
 * 要进程 token 才给（静态资源才是公开的），所以没法直接截「活的」页面。
 * 这里改用同一份 client.js + 真实的主题 token 值离线渲染，
 * 目的是让评审（和 agent 自己）在改样式之后能看到真实间距与底色，而不是靠想象。
 *
 * 用法：node preview.mjs            → 生成 preview/*.html
 *      再对每个 html 跑一次 headless Chrome --screenshot（见 README 注释）
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// ── 1. 从 client.js 里取出真实的 CSS 与组件 ─────────────────────────────────
const src = readFileSync(new URL("./plugin/lib/client.js", import.meta.url), "utf8");
const cssMatch = src.match(/const css = `([\s\S]*?)`;/);
if (!cssMatch) throw new Error("没能从 client.js 里取出 css 模板串");
const pluginCss = cssMatch[1];

let hookIndex = 0;
let hooks = {};
const react = {
	createElement(type, props, ...children) {
		const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true);
		const p = { ...(props ?? {}) };
		if (flat.length === 1) p.children = flat[0];
		else if (flat.length > 1) p.children = flat;
		return { type, props: p, children: flat };
	},
	useState(init) {
		const i = hookIndex++;
		const forced = Object.prototype.hasOwnProperty.call(hooks, i);
		return [forced ? hooks[i] : typeof init === "function" ? init() : init, () => {}];
	},
	useMemo: (fn) => fn(),
	useRef: (v) => ({ current: v }),
	useEffect() {},
	Fragment: "Fragment",
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
globalThis.document = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
	head: { appendChild() {} },
};
// eslint-disable-next-line no-new-func
new Function("window", "document", src)(globalThis.window, globalThis.document);

const mod = captured.factory((name) => {
	if (name === "react") return react;
	throw new Error("unexpected require: " + name);
});
let mainComponent = null;
mod.apply({
	slots: {
		inject: (_key, cb) => cb(),
		register: (options, component) => {
			if (options.name === "main") mainComponent = component;
			return () => {};
		},
	},
});
if (mainComponent === null) throw new Error("没拿到 main 席位的组件");

// ── 2. 元素树 → HTML ────────────────────────────────────────────────────────
const VOID = new Set(["input", "br", "hr", "img", "meta", "link"]);
const ATTR = { tabIndex: "tabindex", className: "class", htmlFor: "for" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function serialize(node) {
	if (node === null || node === undefined || node === false || node === true) return "";
	if (Array.isArray(node)) return node.map(serialize).join("");
	if (typeof node === "string" || typeof node === "number") return esc(node);
	const { type, props } = node;
	if (typeof type === "function") return serialize(type(props));
	if (type === "Fragment" || type === "React.Fragment") return serialize(props?.children);
	const attrs = [];
	for (const [k, v] of Object.entries(props ?? {})) {
		if (v === undefined || v === null || k === "children" || k === "key" || k === "ref") continue;
		if (k.startsWith("on") || k === "defaultValue") continue;
		if (k === "style") {
			const text = Object.entries(v).map(([p, val]) => p.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()) + ":" + val).join(";");
			attrs.push(`style="${esc(text)}"`);
			continue;
		}
		attrs.push(`${ATTR[k] ?? k}="${esc(v)}"`);
	}
	const open = `<${type}${attrs.length ? " " + attrs.join(" ") : ""}>`;
	if (VOID.has(type)) return open;
	// 静态 HTML 不认 value 属性，得把对应 option 标成 selected，否则截图永远显示第一个选项
	if (type === "select") {
		const kids = (Array.isArray(props?.children) ? props.children : [props?.children]).filter(Boolean);
		const inner = kids.map((k) =>
			k !== null && typeof k === "object" && k.type === "option" && String(k.props?.value ?? "") === String(props?.value ?? "")
				? { ...k, props: { ...k.props, selected: true } }
				: k,
		);
		return open + inner.map(serialize).join("") + "</select>";
	}
	if (type === "textarea" && props?.defaultValue !== undefined) return open + esc(props.defaultValue) + "</textarea>";
	return open + serialize(props?.children) + `</${type}>`;
}

// ── 3. 真实主题 token（浅色档，取自 dsh-client-ui-theme 的定义）───────────────
const TOKENS = `
:root{
--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-50:#f9fafb;--dsw-static-neutral-bluish-60:#f5f6f7;
--dsw-static-neutral-bluish-100:#ebeef2;--dsw-static-neutral-bluish-200:#e1e5ee;--dsw-static-neutral-bluish-300:#cfd3d6;
--dsw-static-neutral-bluish-400:#adb2b8;--dsw-static-neutral-bluish-600:#81858c;--dsw-static-neutral-bluish-700:#61666b;
--dsw-static-neutral-bluish-1000:#0f1115;
--dsw-static-amber-100:#fef5e7;--dsw-static-amber-500:#f59e0b;--dsw-static-amber-600:#dd8629;
--dsw-static-green-100:#e6faed;--dsw-static-green-500:#22c55e;--dsw-static-red-600:#ec1313;--dsw-static-deepseek-500:#4176e6;
--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-layer-3:var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-module-platform:var(--dsw-static-neutral-bluish-60);
--dsw-alias-border-l1:#0000000a;--dsw-alias-border-l2:#0000001a;--dsw-alias-border-l3:#0000001f;--dsw-alias-border-l4:#00000029;
--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000);
--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-700);
--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-600);
--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-400);
--dsw-alias-interactive-bg-hover:#2631480f;--dsw-alias-interactive-bg-active:#2631481a;
--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);
--dsw-alias-state-warn-tertiary:var(--dsw-static-amber-100);
--dsw-alias-state-warn-label:var(--dsw-static-amber-600);
--dsw-alias-state-success-primary:var(--dsw-static-green-500);
--dsw-alias-state-success-tertiary:var(--dsw-static-green-100);
--dsw-alias-state-error-primary:var(--dsw-static-red-600);
--dsw-alias-state-business-primary:var(--dsw-static-deepseek-500);
--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-1000);
--dsw-elevation-prominent:0 0 0 1px var(--dsw-alias-border-l4), 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d;
--dsw-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
}`;

/**
 * 三个画面，正好回应这轮的两条反馈：
 *  1 → 三栏分界（圆角面板 + 底色分层 + 底部常驻动作区）
 *  2/3 → 「状态即可交互」：点顶部计数或卡片状态标签筛选 + 该状态专属主行动
 */
/** 简历库的真数据由 GET /boss/state 给；离线预览直接喂一份等价结构。 */
const DEMO_REMOTE = {
	ok: true,
	resumes: {
		count: 2, parsed: 1, defaultResume: "A_通用_v3.docx",
		files: [
			{
				name: "A_通用_v3.docx", ext: ".docx", bytes: 20480, status: "parsed", textPath: "resume-text/A_通用_v3.docx.txt", role: "base",
				structured: {
					name: "张伟", city: "北京", degree: "本科", degrees: ["本科"], yoe: 5, seniority: "mid",
					phone: "13800000000", email: "zhangwei@example.com", targetTitles: ["后端工程师"],
					skills: ["Java", "Spring Boot", "Spring Cloud", "MySQL", "Redis", "Kafka", "Docker", "分布式", "高并发"],
					experience: [{ company: "中科智联科技有限公司", title: "后端工程师", period: "2021.03 - 至今" }],
				},
			},
			{ name: "B_扫描件.pdf", ext: ".pdf", bytes: 900, status: "failed", error: "PDF 里没有任何文字绘制指令（不做 OCR）", warnings: [] },
		],
	},
	jobs: [], profile: { homeCity: "北京" }, session: { present: false },
};

/** 余额：真值来自宿主半边的 GET /boss/balance，离线预览喂一个等价结构（真实数字见截图时点）。 */
const BAL = { ok: true, currency: "CNY", total: 8.04, granted: 0, toppedUp: 8.04, at: "2026-09-17T10:00:00Z" };

const SHOTS = [
	{ name: "preview-1-条件条与距离", hooks: { 0: "j1", 11: BAL } },
	{ name: "preview-2-只要北京10km内", hooks: { 0: "j1", 4: "北京", 6: 10, 11: BAL } },
	// 简历库：上传进度 + 展开的结构化卡片 + 一份解析失败的（注意 12 是简历库的展开表）
	{ name: "preview-3-简历库", hooks: { 0: "j1", 7: DEMO_REMOTE, 12: { "A_通用_v3.docx": true }, 10: [{ name: "C_新简历.pdf", pct: 68, phase: "uploading", error: null }], 11: BAL } },
	{ name: "preview-4-已回复", hooks: { 0: "j3", 2: "replied", 3: 1, 11: BAL } },
];

const outDir = new URL("./preview/", import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const shot of SHOTS) {
	hooks = shot.hooks;
	hookIndex = 0;
	const body = serialize(mainComponent({}));
	const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${shot.name}</title>
<style>${TOKENS}
html,body{margin:0;background:#fff;font-family:var(--dsw-font-family);-webkit-font-smoothing:antialiased}
#frame{width:1240px;height:640px;overflow:hidden}
${pluginCss}
</style></head>
<body><div id="frame">${body}</div></body></html>`;
	writeFileSync(new URL(`${shot.name}.html`, outDir), html, "utf8");
	console.log(`wrote preview/${shot.name}.html  (${html.length} bytes)`);
}
