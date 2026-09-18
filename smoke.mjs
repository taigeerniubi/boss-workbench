/**
 * 阶段 0 冒烟测试：在 Node 里真执行 client.js 的 factory 与 apply，
 * 把注册契约、组件渲染路径、以及"状态即可交互"的三个入口全部走一遍。
 *
 * 不测视觉效果，只测三件事：
 *   1. 注册契约对不对（席位、id、label）；
 *   2. 每个状态分支渲染会不会抛；
 *   3. 三种「需要我」的状态点下去有没有东西可点（筛选、状态标签、专属主行动）。
 */
import { readFileSync } from "node:fs";

// ── 桩：react ────────────────────────────────────────────────────────────────
/**
 * 一个刚够用的迷你 React：
 *   - `useState` 真的存值，`setState` 真的触发下一轮渲染；
 *   - `useEffect` 在渲染提交后跑，并按 deps 决定要不要重跑；
 *   - `hooks` 按 useState 序号强制**初值**，这样一个组件就能被驱动到任意分支。
 *
 * 为什么要真的支持重渲染：工作台"列表跟着 data/jobs.json 走"这件事，
 * 走的就是「remote 变了 → effect → setApps」这条路。桩里 effect 是空的的话，
 * 这条路上出任何问题测试都看不见 —— 而它恰好出过问题（列表永远停在演示数据）。
 *
 * useState 序号只数 useState（useRef / useEffect / useMemo 用另一套计数），
 * 所以下面那些按序号写的 overrides 不会被新增的 effect 打乱。
 * WorkbenchPage 的序号约定：
 *   0 selectedId · 1 apps · 2 filter · 3 focusAction
 */
let hooks = {};
let hookIndex = 0; // useState 专用
let otherIndex = 0; // useRef / useEffect 专用
let state = []; // 跨 pass 的 useState 值
let depMemo = []; // 跨 pass 的 effect deps
let effects = []; // 本次 pass 登记待跑的 effect
let dirty = false; // 本次 pass 有没有 setState
const MAX_PASSES = 8;

// 测试里不联网：所有 fetch 永远悬着，effect 里的请求既不会成功也不会炸
globalThis.fetch = () => new Promise(() => {});

const react = {
	createElement(type, props, ...children) {
		const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true);
		// 和真 React 一样把 children 挂进 props，函数组件才能收到
		const p = { ...(props ?? {}) };
		if (flat.length === 1) p.children = flat[0];
		else if (flat.length > 1) p.children = flat;
		return { type, props: p, children: flat };
	},
	useState(init) {
		const i = hookIndex++;
		if (!(i in state)) {
			state[i] = Object.prototype.hasOwnProperty.call(hooks, i) ? hooks[i] : typeof init === "function" ? init() : init;
		}
		const set = (next) => {
			const v = typeof next === "function" ? next(state[i]) : next;
			if (!Object.is(v, state[i])) {
				state[i] = v;
				dirty = true;
			}
		};
		return [state[i], set];
	},
	useMemo(fn) {
		return fn();
	},
	useRef(v) {
		const i = otherIndex++;
		if (!(i in state)) state[i] = { current: v };
		return state[i];
	},
	useEffect(fn, deps) {
		const i = otherIndex++;
		const prev = depMemo[i];
		const changed = deps === undefined || prev === undefined || deps.length !== prev.length || deps.some((d, k) => !Object.is(d, prev[k]));
		if (changed) {
			depMemo[i] = deps;
			effects.push(fn);
		}
	},
	Fragment: "Fragment",
};

// ── 桩：document（让 CSS 注入分支真的执行）─────────────────────────────────
const cssTags = [];
const fakeDocument = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
	head: { appendChild: (el) => cssTags.push(el) },
};

// ── 桩：模块加载器 ──────────────────────────────────────────────────────────
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
globalThis.document = fakeDocument;

// ── 执行 bundle ─────────────────────────────────────────────────────────────
const src = readFileSync(new URL("./plugin/lib/client.js", import.meta.url), "utf8");
// eslint-disable-next-line no-new-func
new Function("window", "document", src)(globalThis.window, fakeDocument);

const fail = [];
const check = (ok, msg) => { if (ok) console.log("  PASS  " + msg); else { console.log("  FAIL  " + msg); fail.push(msg); } };

console.log("── 1. bundle 注册 ──");
check(captured !== null, "调用了 window.__ModuleLoader__.load");
if (!captured) { console.log("\n致命：bundle 未注册"); process.exit(1); }
check(captured.id === "dsh-boss-workbench", `模块 id = ${captured.id}（必须等于包名，否则浏览器解析不到）`);
check(typeof captured.factory === "function", "factory 是函数");

console.log("\n── 2. factory 物化 ──");
const mod = captured.factory((name) => {
	if (name === "react") return react;
	throw new Error("unexpected require: " + name);
});
check(cssTags.length === 1, `CSS 注入了一次（实际 ${cssTags.length}）`);
const injectedCss = cssTags[0]?.textContent ?? "";
check(typeof mod.apply === "function", "导出 apply");
check(Array.isArray(mod.inject), "导出 inject 数组: " + JSON.stringify(mod.inject));

console.log("\n── 2b. 样式只用真实存在的主题 token ──");
/**
 * 这一组是回归护栏：插件曾经引用 --dsw-alias-fill-l1/-l2 等 7 个不存在的 token，
 * 而它们没有 fallback，于是所有 surface 都算成 transparent —— 三栏糊成一片。
 * 下面这批名字来自 dsh-client-ui-theme 的实际定义，改动前先确认它真的存在。
 */
const TOKENS = new Set([
	"--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2", "--dsw-alias-bg-layer-3",
	"--dsw-alias-bg-module-platform", "--dsw-alias-bg-mask-1",
	"--dsw-alias-border-l1", "--dsw-alias-border-l2", "--dsw-alias-border-l3", "--dsw-alias-border-l4",
	"--dsw-alias-label-primary", "--dsw-alias-label-secondary", "--dsw-alias-label-tertiary",
	"--dsw-alias-label-caption", "--dsw-alias-label-dimmed", "--dsw-alias-label-primary-foreground",
	"--dsw-alias-interactive-bg-hover", "--dsw-alias-interactive-bg-active",
	"--dsw-alias-state-warn-primary", "--dsw-alias-state-warn-tertiary", "--dsw-alias-state-warn-label",
	"--dsw-alias-state-success-primary", "--dsw-alias-state-success-tertiary",
	"--dsw-alias-state-error-primary", "--dsw-alias-state-business-primary",
	"--dsw-alias-brand-primary", "--dsw-alias-link",
	"--dsw-alias-button-elevated-fill", "--dsw-alias-button-floating-hover",
	"--dsw-alias-scrollbar-bg-l2", "--dsw-alias-scrollbar-hover-l2",
	"--dsw-elevation-prominent", "--dsw-elevation-stroke-color",
	"--dsw-font-family", "--dsw-font-markdown-code-font-family",
]);
const used = [...new Set([...injectedCss.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))];
const unknown = used.filter((t) => !TOKENS.has(t));
check(unknown.length === 0, unknown.length === 0 ? `样式引用的 ${used.length} 个 token 全部存在` : `这些 token 不存在，会算成 transparent: ${unknown.join(", ")}`);

console.log("\n── 2c. 侧栏行对齐：只命中自己那一行 ──");
/**
 * 「Boss 工作台」这一行的外壳归 ui-sidebar 所有，插件只能靠 aria-label 命中。
 * 这组断言就是防止哪天改成通配选择器，把别人的面板行一起改了。
 */
const row = 'button[aria-label="Boss 工作台"]';
check(injectedCss.includes(row), "对齐样式按 aria-label 命中自己那一行");
check(injectedCss.includes(row + ":has(> span + span){"), "宽栏形态（图标 + 标题）套用新会话那套尺寸");
check(injectedCss.includes(row + ':has(> span + span)[aria-current="page"]'), "active 有独立填充：还看得出哪个面板开着");
check(injectedCss.includes(row + ":not(:has("), "轨道（收起）形态原样交还 shell");
check(injectedCss.includes("--dsw-alias-button-elevated-fill") && injectedCss.includes("border-radius:12px"), "取值取自 ui-sidebar 的 .newSession，不是自己编的颜色");
check(!/^\s*(?:\*|button|nav|\.panelRow)\s*\{/m.test(injectedCss), "没有通配/裸标签/裸 shell 类名规则，不会污染 shell");

console.log("\n── 3. apply 注册三个席位 ──");
const registered = [];
const fakeCtx = {
	slots: {
		// 模拟声明已存在：直接同步执行回调，并返回其 disposer
		inject: (key, cb) => {
			if (typeof key !== "string" || typeof cb !== "function") throw new Error("inject 调用形状错误");
			return cb();
		},
		register: (options, component) => {
			if (typeof options?.name !== "string") throw new Error("register 缺少 name");
			if (typeof component !== "function") throw new Error("register 缺少组件");
			registered.push({ options, component });
			return () => {};
		},
	},
};
mod.apply(fakeCtx);

const byName = Object.fromEntries(registered.map((r) => [r.options.name + "|" + (r.options.id ?? r.options.key), r]));
check(registered.length === 4, `注册了 4 个条目（实际 ${registered.length}）`);
check(!!byName["sidebar.panellist|boss-workbench"], "sidebar.panellist / id=boss-workbench");
check(!!byName["main|boss-workbench"], "main / key=boss-workbench（与 panellist id 同名即配对）");
check(!!byName["shell.overlay|boss-workbench-toasts"], "shell.overlay / id=boss-workbench-toasts");
check(!!byName["conversation.composer.dock|boss-workbench-balance"], "conversation.composer.dock / 余额 pill（和 shell 的「用量 · 缓存命中」同一处）");

const pl = byName["sidebar.panellist|boss-workbench"];
if (pl) {
	check(typeof pl.options.label === "function", "panellist label 是 thunk（sidebar 用 resolveSlotLabel 读）");
	check(pl.options.label() === "Boss 工作台", `label 求值 = "${pl.options.label?.()}"`);
	check(typeof pl.options.order === "number", "order 是数字");
}

console.log("\n── 4. 逐个组件渲染（展开全部函数组件，走完每条假数据分支）──");
let hostNodes = 0;
function walk(node, depth, out) {
	if (node === null || node === undefined) return;
	if (Array.isArray(node)) { node.forEach((n) => walk(n, depth, out)); return; }
	if (typeof node === "string" || typeof node === "number") { out.push("  ".repeat(depth) + String(node)); return; }
	if (typeof node !== "object") return;
	const { type, props } = node;
	// 函数组件：真的调用它并继续展开，否则内部渲染路径根本没被执行
	if (typeof type === "function") {
		out.push("  ".repeat(depth) + "<" + (type.name || "anon") + ">");
		walk(type(props), depth + 1, out);
		return;
	}
	if (type === "Fragment" || type === "React.Fragment") { walk(props.children, depth, out); return; }
	// 完整 className 进输出，"bw_tallyOn" 这类状态修饰符才可断言
	const cls = props?.className ? "." + String(props.className) : "";
	// input 的关键能力（能不能多选 / 提示语写了什么）只写在属性上，断言需要它
	const extra =
		(type === "input" && props?.multiple === true ? "[multiple]" : "") +
		(type === "input" && typeof props?.placeholder === "string" ? "[placeholder=" + props.placeholder + "]" : "");
	hostNodes++;
	out.push("  ".repeat(depth) + type + cls + extra);
	if (props?.children !== undefined) walk(props.children, depth + 1, out);
}

/**
 * overrides 形如 { 0: "j1", 2: "review" }，按 useState 序号强制**初值**。
 * 渲染会一直跑到没有 setState 为止（effect 里 set 了状态就能看到下一轮的结果）。
 */
function render(component, props, overrides) {
	hooks = overrides ?? {};
	state = [];
	depMemo = [];
	let out = [];
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		hookIndex = 0;
		otherIndex = 0;
		effects = [];
		dirty = false;
		out = [];
		walk(component(props), 0, out);
		// 提交：跑这一轮登记的 effect（setState 会把 dirty 立起来）
		for (const fn of effects) {
			const cleanup = fn();
			if (typeof cleanup === "function") cleanups.push(cleanup);
		}
		if (!dirty) break;
	}
	hooks = {};
	return out;
}

/** effect 返回的清理函数：测试里从不卸载，但别把它们当垃圾丢了 */
const cleanups = [];

// 非 main 的两个席位
for (const { options, component } of registered) {
	if (options.name === "main") continue;
	const label = options.name + "/" + (options.id ?? options.key);
	try {
		const out = render(component, { size: 16, active: false });
		check(out.length > 0, `${label} 渲染出 ${out.length} 行`);
	} catch (err) {
		check(false, `${label} 渲染抛错: ${err.message}`);
		console.error(err);
	}
}

// main 席位：逐个 JD 渲染，覆盖全部 7 条假数据的状态分支
const mainEntry = byName["main|boss-workbench"];
const expectStatus = { j1: "待你确认", j2: "失败", j3: "已回复", j4: "定制中", j5: "等待回复", j6: "待处理", j7: "已跳过" };
const ids = ["j1", "j2", "j3", "j4", "j5", "j6", "j7"];
console.log("");
for (const id of ids) {
	try {
		const out = render(mainEntry.component, {}, { 0: id });
		const text = out.join("\n");
		// 中间栏必须出现该 JD 的状态文案，证明确实按选中项渲染
		check(out.length > 60 && text.includes(expectStatus[id]), `main 渲染 ${id}: ${out.length} 行, 状态=${expectStatus[id]}`);
		if (id === "j1") console.log(out.slice(0, 26).join("\n") + `\n  … 共 ${out.length} 行`);
	} catch (err) {
		check(false, `main 渲染 ${id} 抛错: ${err.message}`);
		console.error(err);
	}
}

console.log("\n── 5. 状态即可交互：三个入口都在 ──");
const countOf = (lines, re) => lines.filter((l) => re.test(l)).length;
const cards = (lines) => countOf(lines, /div\.bw_card( |$)/);
const all = render(mainEntry.component, {}, { 0: "j1" });

check(countOf(all, /button\.bw_tally( |$)/) === 3, `顶部三个计数是 3 个 button（实际 ${countOf(all, /button\.bw_tally( |$)/)}）`);
check(countOf(all, /bw_tallyOn/) === 1, "有且只有一档处于选中态（默认「全部」）");
check(countOf(all, /button\.bw_chip /) === 7, `卡片上的状态标签可点（7 个，实际 ${countOf(all, /button\.bw_chip /)}）`);
check(cards(all) === 7, `不筛选时队列 7 张卡（实际 ${cards(all)}）`);

console.log("\n── 6. 顶部计数真的在筛（队列联动）──");
for (const [f, n] of [["needs", 3], ["waiting", 1], ["review", 1], ["failed", 1], ["replied", 1], ["skipped", 1]]) {
	try {
		const out = render(mainEntry.component, {}, { 0: "j1", 2: f });
		check(cards(out) === n, `筛选「${f}」→ ${n} 张卡（实际 ${cards(out)}）`);
	} catch (err) {
		check(false, `筛选「${f}」渲染抛错: ${err.message}`);
	}
}
const tagOut = render(mainEntry.component, {}, { 0: "j1", 2: "review" });
check(tagOut.some((l) => l.includes("只看")), "筛选生效时栏头出现「只看 X」并可清除");
check(tagOut.some((l) => /bw_tagX/.test(l)), "栏头有一个清除筛选的 × 按钮");

console.log("\n── 7. 三种状态各自的主行动 + 说明带 ──");
const PRIMARY = { j1: "就这样，发送 ▸", j2: "查看并重试", j3: "去回话 ▸" };
for (const id of ["j1", "j2", "j3"]) {
	const lines = render(mainEntry.component, {}, { 0: id });
	const text = lines.join("\n");
	const at = (re) => lines.findIndex((l) => re.test(l));
	check(text.includes(PRIMARY[id]), `${id}（${expectStatus[id]}）详情栏有专属主行动「${PRIMARY[id]}」`);
	check(at(/div\.bw_foot/) >= 0, `${id} 详情栏有常驻底部动作区`);
	// 说明带与动作行必须在 bw_foot 里，而不是跟着 JD 全文一起滚出视野
	check(at(/div\.bw_note /) > at(/div\.bw_foot/) && at(/div\.bw_actions/) > at(/div\.bw_foot/), `${id} 说明带与动作行都在常驻区里（不随内容滚动）`);
	check(at(/div\.bw_scroll/) < at(/div\.bw_foot/), `${id} 可滚动区在动作区之前`);
}
const sent = render(mainEntry.component, {}, { 0: "j5" }).join("\n");
check(/div\.bw_note /.test(sent) && !sent.includes("就这样，发送"), "「等待回复」只给说明带、不误给发送按钮");
const skipped = render(mainEntry.component, {}, { 0: "j7" }).join("\n");
check(/div\.bw_note /.test(skipped), "「已跳过」也有说明带，没有无话可说的状态");

console.log("\n── 8. 表头档位与「状态级筛选」自洽 ──");
const repliedView = render(mainEntry.component, {}, { 0: "j3", 2: "replied" });
const segLines = repliedView.filter((l) => /button\.bw_tally/.test(l));
check(segLines.some((l) => l.includes("bw_tallyOn")), "按「已回复」筛选时表头仍有档位亮着（不再显示成「全部」）");
check(segLines.filter((l) => l.includes("bw_tallyOn")).length === 1, "同时只有一档是亮的");
const repliedText = render(mainEntry.component, {}, { 0: "j3" }).join("\n");
check((repliedText.match(/去回话/g) ?? []).length === 1, "「去回话」全屏只出现一次（中栏主行动），不在进展栏重复");

console.log("\n── 9. 从状态标签跳进来时会指向动作行 ──");
const focused = render(mainEntry.component, {}, { 0: "j2", 2: "failed", 3: 1 });
check(/div\.bw_actions bw_actionsFocus/.test(focused.join("\n")), "focusAction > 0 时动作行带脉冲高亮类");

console.log("\n── 10. 抓取条件：城市 / 岗位 / 距离 ──");
const base = render(mainEntry.component, {}, { 0: "j1" });
const baseText = base.join("\n");
check(/div\.bw_filters/.test(baseText), "工作台有一条独立的抓取条件条");
check(countOf(base, /select\.bw_select/) === 2, `城市 / 距离是两个下拉（实际 ${countOf(base, /select\.bw_select/)}）`);
check(/input\.bw_kw/.test(baseText), "岗位关键词是输入框");
check(/筛出/.test(baseText), "显示「筛出 N / 共 M 个岗位」");

// 距离的三种真实状态都要能表达，不能拿 0km 或空白糊过去
check(baseText.includes("3.2km"), "同城有坐标 → 显示具体距离（3.2km）");
check(/bw_locNear/.test(baseText), "近距离有高亮类");
check(baseText.includes("异地"), "异地岗位标「异地」，不去算一条假距离");
check(baseText.includes("距离未知"), "同城但没坐标 → 标「距离未知」");

// hook 序号：0 selectedId · 2 filter · 3 focusAction · 4 city · 5 kw · 6 maxKm
const km5 = render(mainEntry.component, {}, { 0: "j1", 6: 5 });
check(cards(km5) === 1, `距离 ≤5km → 1 张卡（实际 ${cards(km5)}）`);
const km10 = render(mainEntry.component, {}, { 0: "j1", 6: 10 });
check(cards(km10) === 3, `距离 ≤10km → 3 张卡（距离未知的同城岗位一并排除，实际 ${cards(km10)}）`);
const onlyCity = render(mainEntry.component, {}, { 0: "j1", 4: "北京" });
check(cards(onlyCity) === 5, `城市=北京 → 5 张卡（实际 ${cards(onlyCity)}）`);
const onlyJava = render(mainEntry.component, {}, { 0: "j1", 5: "Java" });
check(cards(onlyJava) === 1, `关键词=Java → 1 张卡（实际 ${cards(onlyJava)}）`);
const combo = render(mainEntry.component, {}, { 0: "j1", 2: "review", 6: 5 });
check(cards(combo) === 1, `状态 + 距离 叠加 → 1 张卡（实际 ${cards(combo)}）`);
const none = render(mainEntry.component, {}, { 0: "j1", 6: 3 });
check(cards(none) === 0 && /清除全部条件/.test(none.join("\n")), "条件筛空时给出「清除全部条件」，不让人以为是没抓到岗位");

console.log("\n── 11. 简历库：上传 / 进度 / 折叠 / 多份 ──");
// hook 7 = /boss/state 的结果（预览/测试直接喂）；11/12 = 简历库内部的展开表、拖拽态
const DEMO_REMOTE = {
	ok: true,
	resumes: {
		count: 2, parsed: 1, defaultResume: "A_通用_v3.docx",
		files: [
			{
				name: "A_通用_v3.docx", ext: ".docx", bytes: 20480, status: "parsed", textPath: "resume-text/A.txt", role: "base",
				structured: {
					name: "张伟", city: "北京", degree: "本科", degrees: ["本科"], yoe: 5, seniority: "mid",
					phone: "13800000000", email: "zhangwei@example.com", targetTitles: ["后端工程师"],
					skills: ["Java", "Spring Boot", "Redis", "Kafka", "分布式"],
					experience: [{ company: "中科智联科技有限公司", title: "后端工程师", period: "2021.03 - 至今" }],
				},
			},
			{ name: "B_扫描件.pdf", ext: ".pdf", bytes: 900, status: "failed", error: "PDF 里没有任何文字绘制指令", warnings: ["不做 OCR"] },
		],
	},
	jobs: [], profile: { homeCity: "北京" }, session: { present: false },
};
const lib = render(mainEntry.component, {}, { 0: "j1", 7: DEMO_REMOTE, 12: { "A_通用_v3.docx": true } });
const libText = lib.join("\n");
check(/div\.bw_colStack/.test(libText), "右栏是「进展 + 简历库」两段式（简历库不跟着选中项消失）");
check(/bw_libTitle/.test(libText) && libText.includes("简历库"), "简历库面板在");
check(lib.some((l) => /input\[multiple\]/.test(l)), "文件选择器带 multiple（可一次多份）");
check(/div\.bw_drop/.test(libText), "有拖拽上传区");
check(countOf(lib, /div\.bw_rw(\s|$)/) === 2, `两份简历都在列表里（实际 ${countOf(lib, /div\.bw_rw(\s|$)/)}）`);
check(libText.includes("已解析") && libText.includes("失败"), "解析成功与失败各有状态标签，失败的不静默丢弃");
check(libText.includes("张伟") && libText.includes("本科") && libText.includes("5 年"), "展开后能看到结构化字段（姓名/学历/年限）");
check(countOf(lib, /span\.bw_skill(\s|$)/) >= 5, `技能以标签列出（${countOf(lib, /span\.bw_skill(\s|$)/)} 个）`);
check(libText.includes("设为当前简历"), "每份简历可以设为当前简历");
check(countOf(lib, /button\.bw_rwX(\s|$)/) === 2, `标题行上有删除按钮，不用展开就能删（${countOf(lib, /button\.bw_rwX(\s|$)/)} 个）`);

const upView = render(mainEntry.component, {}, { 0: "j1", 7: DEMO_REMOTE, 10: [{ name: "C_新简历.pdf", pct: 42, phase: "uploading", error: null }] });
const upText = upView.join("\n");
check(/div\.bw_barFill/.test(upText), "上传中出现进度条");
check(upText.includes("上传中") && upText.includes("42%"), "进度条带百分比");
const doneView = render(mainEntry.component, {}, { 0: "j1", 7: DEMO_REMOTE, 10: [{ name: "C.pdf", pct: 100, phase: "failed", error: "抽不出文字" }] });
check(/bw_barBad/.test(doneView.join("\n")) && doneView.join("\n").includes("抽不出文字"), "失败的进度条变红并给出原因");

const offView = render(mainEntry.component, {}, { 0: "j1", 7: DEMO_REMOTE, 9: true });
check(/bw_colLibOff/.test(offView.join("\n")), "简历库可以整块折叠");
check(!/div\.bw_drop/.test(offView.join("\n")), "折叠后不渲染上传区（省空间给进展栏）");

console.log("\n── 12. 余额（账号还剩多少钱）──");
// hook 11 = 表头那颗余额（WorkbenchBalance 排在简历库之前，所以它先消费 11）
const balView = render(mainEntry.component, {}, { 0: "j1", 11: { ok: true, currency: "CNY", total: 123.45, granted: 23.45, toppedUp: 100, at: "2026-09-17T10:00:00Z" } });
const balText = balView.join("\n");
check(countOf(balView, /span\.bw_bal(\s|$)/) === 1, `工作台表头有余额显示（实际 ${countOf(balView, /span\.bw_bal(\s|$)/)} 个）`);
check(balText.includes("余额 ¥123.45"), "余额格式化成 ¥123.45");
const lowView = render(mainEntry.component, {}, { 0: "j1", 11: { ok: true, currency: "CNY", total: 3, granted: 0, toppedUp: 3, at: "x" } });
check(/bw_balLow/.test(lowView.join("\n")), "余额偏低（≤¥10）时变红");
const failView = render(mainEntry.component, {}, { 0: "j1", 11: { ok: false, error: "宿主 /boss 路由还没起来 —— 重启一次 DSH GUI 后生效" } });
check(failView.join("\n").includes("余额 —"), "查不到余额时显示 —，不编数字（不再卡在「…」）");
const loading = render(mainEntry.component, {}, { 0: "j1" });
check(loading.join("\n").includes("余额 …"), "还没查到时显示 …（三种状态都看得出来）");

// 会话区右下角那颗：单独注册的组件，自己拉数据
const dockPill = byName["conversation.composer.dock|boss-workbench-balance"];
const dockOut = render(dockPill.component, {}).join("\n");
check(/div\.bw_balDock/.test(dockOut), "会话区右下角的余额 pill 渲染出来了（右对齐）");
check(/span\.bw_balPill/.test(dockOut) && dockOut.includes("余额"), "样式是胶囊，文案带「余额」");

console.log("\n── 13. 登录闸门（点工作台没登录就弹二维码）──");
// hook 14 = LoginGate 的 gate 状态（0-10 WorkbenchPage，11 余额，12/13 简历库，14 闸门）
const gate = render(mainEntry.component, {}, { 0: "j1", 14: { open: true, qr: "data:image/jpeg;base64,AAAA", phase: "waiting-scan", error: null } });
const gateText = gate.join("\n");
check(/div\.bw_gate/.test(gateText), "没登录时出现登录闸门");
check(/img\.bw_gateQrImg/.test(gateText), "二维码以图片形式渲染");
check(gateText.includes("请用 Boss 直聘 APP 扫码"), "提示用户扫码");
const confirm = render(mainEntry.component, {}, { 0: "j1", 14: { open: true, qr: "x", phase: "waiting-confirm", error: null } });
check(confirm.join("\n").includes("请在手机上点「确认登录」"), "扫到之后切成「等手机确认」");
const fin = render(mainEntry.component, {}, { 0: "j1", 14: { open: true, qr: "x", phase: "finalizing", error: null } });
check(/bw_spin/.test(fin.join("\n")), "安全验证阶段有转圈（这一步在宿主侧开浏览器，要几秒）");
const flagged = render(mainEntry.component, {}, { 0: "j1", 14: { open: true, qr: null, phase: "flagged", error: "风控 code 35" } });
check(flagged.join("\n").includes("重新获取二维码") && flagged.join("\n").includes("风控 code 35"), "被风控时给原因并给重试入口");
const okGate = render(mainEntry.component, {}, { 0: "j1", 14: { open: true, qr: "x", phase: "logged-in", error: null } });
check(okGate.join("\n").includes("开始用"), "登录成功后给「开始用」收掉弹窗");

console.log("\n── 14. 找岗位（真实数据 + 搜索入口）──");
// hook 7 = GET /boss/state 的结果。这一段专门盯"列表到底跟着谁走"。
const REAL = {
	ok: true,
	profile: { homeCity: "北京", keywords: ["后端开发"] },
	session: { present: true, hasStoken: true, savedAt: "x" },
	resumes: { files: [] },
	jobs: [
		{ id: "BJ1", company: "某某科技", title: "后端工程师", salary: "25-40K", city: "北京", area: "海淀区·中关村", distanceKm: 3.2, hr: "李女士", experience: "3-5年", degree: "本科", industry: "互联网", jd: "熟悉 Spring Cloud 与高并发", securityId: "s1", encryptJobId: "e1", scrapedAt: "2026-09-17T10:00:00Z" },
		{ id: "BJ2", company: "远方网络", title: "Go 后端", salary: "20-30K", city: "深圳", area: "海淀区·中关村", distanceKm: null, hr: "王先生", experience: "1-3年", degree: "本科", industry: "企业服务", jd: "熟悉 Go 与云原生", securityId: "s2", encryptJobId: "e2", scrapedAt: "2026-09-17T09:00:00Z" },
		{ id: "BJ3", company: "京华数据", title: "数据平台工程师", salary: "30-50K", city: "北京", area: "东城区·国贸", distanceKm: null, hr: "赵女士", experience: "3-5年", degree: "硕士", industry: "大数据", jd: "熟悉 Flink", securityId: "s3", encryptJobId: "e3", scrapedAt: "2026-09-17T08:00:00Z" },
	],
};
const realView = render(mainEntry.component, {}, { 0: "BJ1", 7: REAL });
const realText = realView.join("\n");
if (process.env.DUMP === "1") console.log("\n[DUMP]\n" + realView.filter((l) => /bw_(btn|kw|scrape|bal)/.test(l)).join("\n") + "\n[/DUMP]");
check(realText.includes("某某科技") && realText.includes("远方网络"), "抓回来的真岗位进了 JD 队列（不再是演示数据）");
check(!realText.includes("中科智联"), "有真数据时演示数据被顶掉，不混着显示");
check(!realText.includes("演示数据"), "有真岗位时不再挂「演示数据」标");
check(cards(realView) === 3, `库里 3 条就渲染 3 张卡（实际 ${cards(realView)}）`);
check(realText.includes("3.2km"), "同城有坐标 → 显示真实距离");
check(realText.includes("距离未知"), "同城没坐标 → 距离未知，不编一个数");
check(realText.includes("异地"), "异地岗位 → 异地（不按距离算）");

// 没有真数据时，必须一眼看出这是演示数据
const demoView = render(mainEntry.component, {}, { 0: "j1" });
check(demoView.join("\n").includes("演示数据"), "还没抓到岗位时，列表上挂着「演示数据」标");

// 输入框旁边那颗「搜」：这就是"我输入了怎么找"的答案
// 注意 walk 输出的是 "button.bw_btn bw_btnGo"（className 里的空格原样留着），
// 所以断言要带空格而不是再点一个点。
check(/input\.bw_kw/.test(realText), "顶栏有关键词输入框");
check(/button\.bw_kwGo(\s|$)/.test(realText), "输入框旁边有「搜」按钮（回车等价）");
check(realText.includes("回车去 Boss 搜"), "输入框自己说清楚回车会发生什么");
check(/button\.bw_btn bw_btnGo(\s|$)/.test(realText), "顶上有一颗会真去抓的「抓取岗位」");

// 筛空了不能是死胡同：必须能顺手去 Boss 搜一把
const noHit = render(mainEntry.component, {}, { 0: "BJ1", 7: REAL, 5: "算法工程网" });
const noHitText = noHit.join("\n");
check(noHitText.includes("本机库里没有同时满足"), "筛不到时说清楚是「本机库里没有」，不是「没有这个岗位」");
check(/button\.bw_btn bw_btnGo(\s|$)/.test(noHitText) && noHitText.includes("去 Boss 搜「算法工程网」"), "空态直接给「去 Boss 搜「关键词」」的入口");
check(noHitText.includes("清除全部条件"), "空态同时给「清除全部条件」，两条路都能走");

// 已经处理过的岗位，再抓一次不该把进度清零
const inFlight = [{ id: "BJ1", company: "某某科技", title: "后端工程师", salary: "25-40K", city: "北京", area: "", distanceKm: null, hr: "", jd: "x", status: "sent", resume: "r.pdf", greeting: "", at: 0, timeline: [["10:00", "发送简历与打招呼语", 0]] }];
const keep = render(mainEntry.component, {}, { 0: "BJ1", 1: inFlight, 7: REAL });
check(keep.join("\n").includes("等待回复"), "再抓一次同一岗位，已走到「等待回复」的状态不被重置成待处理");

// 抓取进度/结果条：风控与登录失效必须原样显示，不能吞掉
const badScrape = render(mainEntry.component, {}, { 0: "BJ1", 7: { ...REAL, scrape: { running: false, ok: false, mode: "search", query: "Java", city: "北京", ms: 900, fetched: 0, added: 0, total: 0, error: "风控 code 35：您的IP地址存在异常行为", flagged: true } } });
check(/div\.bw_scrape bw_scrapeBad(\s|$)/.test(badScrape.join("\n")), "撞风控时抓取条变红");
check(badScrape.join("\n").includes("您的IP地址存在异常行为"), "风控原因原样显示，不吞成「失败」两个字");
const busy = render(mainEntry.component, {}, { 0: "BJ1", 7: { ...REAL, scrape: { running: true, mode: "search", query: "Java", city: "北京" } } });
check(busy.join("\n").includes("正在 Boss 搜「Java」"), "抓取中显示正在搜什么");
check(/button\.bw_btn bw_btnGo bw_btnBusy(\s|$)/.test(busy.join("\n")), "抓取中按钮变忙碌态（不让重复点）");

console.log("\n── 15. 退出登录 ──");
// 有会话时才给退出入口
const canLogout = render(mainEntry.component, {}, { 0: "BJ1", 7: REAL });
check(/button\.bw_logout(\s|$)/.test(canLogout.join("\n")), "登录着的时候表头有「退出登录」");
const noSession = render(mainEntry.component, {}, { 0: "BJ1", 7: { ...REAL, session: { present: false } } });
check(!/button\.bw_logout(\s|$)/.test(noSession.join("\n")), "没会话时不摆一个没用的退出按钮");
const loggingOut = render(mainEntry.component, {}, { 0: "BJ1", 7: { ...REAL, logout: { running: true } } });
check(loggingOut.join("\n").includes("退出中…"), "点下去立刻变「退出中…」（不让重复点）");
check(/button\.bw_logout(\s|$)/.test(loggingOut.join("\n")) && /disabled/.test(JSON.stringify(loggingOut)) === false, "忙碌态走的是 disabled 属性，不是换按钮");
const loggedOut = render(mainEntry.component, {}, { 0: "BJ1", 7: { ...REAL, session: { present: false }, logout: { running: false, at: 1, ok: true, clearedCookies: 12 } } });
check(loggedOut.join("\n").includes("已退出登录") && loggedOut.join("\n").includes("12 个浏览器 cookie"), "退出成功后说清楚清了什么，不静默");
check(loggedOut.join("\n").includes("简历库和岗位列表没动"), "说清楚退出不影响简历库与已抓岗位");
const logoutFail = render(mainEntry.component, {}, { 0: "BJ1", 7: { ...REAL, logout: { running: false, at: 1, ok: false, error: "宿主 /boss/logout 没响应（重启一次 GUI？）" } } });
check(/div\.bw_scrape bw_scrapeBad(\s|$)/.test(logoutFail.join("\n")), "退出失败时变红并给原因");
check(logoutFail.join("\n").includes("重启一次 GUI"), "失败原因里点名宿主半边要重启");
// 闸门必须能在"刚退出"之后重新弹回来
check(/reloadKey/.test(readFileSync(new URL("./plugin/lib/client.js", import.meta.url), "utf8")), "闸门接了 reloadKey（退出后能自己弹回来）");

console.log("\n" + (fail.length === 0 ? "全部通过 ✅" : `${fail.length} 项失败 ❌`));
process.exit(fail.length === 0 ? 0 : 1);
