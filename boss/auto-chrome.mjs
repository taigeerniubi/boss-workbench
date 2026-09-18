/**
 * 自己把可调试的浏览器拉起来 —— 用户不该为了用插件去敲命令行。
 *
 * ## 为什么这件事本来必须手敲
 *
 * `--remote-debugging-port` 是**启动参数**。进程已经在跑时再敲一次，Chrome 只会
 * 把焦点交给已有窗口、参数被丢掉（单实例语义）。所以只能"先起带参数的"。
 *
 * ## 实测出来的硬约束（Windows / Chrome 153 / Edge 153）
 *
 * | 情况 | 结果 |
 * |---|---|
 * | Chrome 已在运行 → 拉起带调试口的 Chrome | ❌ 新进程立刻退出，`DevToolsActivePort` 不生成 |
 * | Chrome 已在运行 → 拉起带调试口的 **Edge** | ✅ 0.5s 就绪（Edge 没在跑） |
 *
 * 而且这个项目的实际场景更麻烦：**DSH 的 Web GUI 本身可能就开在 Chrome 里**，
 * 关掉 Chrome 等于关掉用户正在看的界面 —— 所以"关了再起"不能作为唯一出路。
 *
 * ## 所以这里的策略
 *
 * 依次试**能真正起得来的**浏览器，谁先起来用谁：
 *   1. 已经在监听 → 直接用，什么都不做；
 *   2. 候选浏览器里，**当前没有在运行的那个**（没在跑 = 不会撞单实例合并）；
 *   3. 全都拿不到调试口 → 如实报出"每个候选为什么不行"，并给出可点的下一步。
 *
 * 三条硬约束：
 *   - **不 kill 任何用户进程**，也**不复用**用户日常窗口的 profile（除非那个浏览器
 *     本来就没在跑 —— 那时用它的 profile 反而能带上现成登录态，见 `reuseProfile`）。
 *   - 只在 `BOSS_AUTO_CHROME !== "0"` 时动手。
 *   - 拉起后**轮询等端口就绪**，有不等的上限。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_DIR, DATA_DIR, SITE, readJson, writeJson } from "./lib.mjs";

/** 调试口。和 browser-channel 的默认值一致。 */
export const DEFAULT_PORT = 9222;
/** 每个候选最多等多久端口就绪。 */
export const LAUNCH_WAIT_MS = Number(process.env.BOSS_LAUNCH_WAIT_MS ?? 12000);
export const autoChromeEnabled = () => process.env.BOSS_AUTO_CHROME !== "0";

const chromePathFile = () => join(DATA_DIR, "chrome-path.json");

/** 候选浏览器的定义。`running` 由调用方探测后注入，便于离线测试。 */
export function browserCandidates({ env = process.env, exists = existsSync, platform = process.platform } = {}) {
	const list = [];
	const push = (name, path, profileDir) => { if (path) list.push({ name, path, profileDir }); };
	if (env.BOSS_CHROME_PATH) push("自定义", env.BOSS_CHROME_PATH, PROFILE_DIR);
	if (platform === "win32") {
		const pf = env.ProgramFiles ?? "C:\\Program Files";
		const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const local = env.LOCALAPPDATA ?? "";
		push("Chrome", join(pf, "Google\\Chrome\\Application\\chrome.exe"), PROFILE_DIR);
		push("Chrome", join(pf86, "Google\\Chrome\\Application\\chrome.exe"), PROFILE_DIR);
		push("Chrome", join(local, "Google\\Chrome\\Application\\chrome.exe"), PROFILE_DIR);
		// Edge 放前面在"Chrome 正开着、Edge 没开"时会更实用 —— 排序在 findLaunchable 里做
		push("Edge", join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"), PROFILE_DIR);
		push("Edge", join(pf, "Microsoft\\Edge\\Application\\msedge.exe"), PROFILE_DIR);
	} else if (platform === "darwin") {
		push("Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", PROFILE_DIR);
		push("Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", PROFILE_DIR);
		push("Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium", PROFILE_DIR);
	} else {
		push("Chrome", "/usr/bin/google-chrome", PROFILE_DIR);
		push("Chrome", "/usr/bin/google-chrome-stable", PROFILE_DIR);
		push("Chromium", "/usr/bin/chromium", PROFILE_DIR);
		push("Chromium", "/usr/bin/chromium-browser", PROFILE_DIR);
		push("Edge", "/usr/bin/microsoft-edge", PROFILE_DIR);
	}
	// 记住的上次成功路径放最前（换过目录/非标准安装时管用）
	const remembered = readJson(chromePathFile(), null)?.path;
	const installed = list.filter((c) => exists(c.path));
	if (typeof remembered === "string" && remembered !== "") {
		const hit = list.find((c) => c.path === remembered);
		if (hit !== undefined) return [hit, ...installed.filter((c) => c.path !== remembered)];
	}
	return installed;
}

/**
 * 挑一个"起得来"的候选：优先当前**没在运行**的浏览器（不会撞单实例合并）。
 * `running` 的键是浏览器小写名：`{chrome, edge, chromium}`。
 */
export function findLaunchable({ running = {}, env = process.env, exists = existsSync, platform = process.platform } = {}) {
	const all = browserCandidates({ env, exists, platform });
	const free = all.filter((c) => running[c.name.toLowerCase()] !== true);
	return { pick: free[0] ?? null, all, free, running };
}

/**
 * 探测浏览器现在有没有在跑。用 tasklist / ps，不依赖任何外部包。
 * 探测失败时 `known: false`，调用方会当成"可能开着"处理（宁可用兜底 profile）。
 */
export function detectRunning({ platform = process.platform, execFileImpl = null } = {}) {
	const execFile = execFileImpl ?? (async (file, args) => {
		const { execFile: realExecFile } = await import("node:child_process");
		return await new Promise((resolve, reject) => {
			realExecFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) })));
		});
	});
	const classify = (lower) => ({
		chrome: lower.includes("chrome.exe") || /google-chrome|chromium/u.test(lower),
		edge: lower.includes("msedge.exe") || lower.includes("msedge") || lower.includes("microsoft-edge"),
		chromium: /chromium/u.test(lower),
	});
	const run = platform === "win32"
		? () => execFile("tasklist", ["/FO", "CSV", "/NH"]).then((out) => String(out?.stdout ?? "").toLowerCase())
		: () => execFile("ps", ["-A", "-o", "comm="]).then((out) => String(out?.stdout ?? "").toLowerCase());
	return run()
		.then((lower) => ({ ...classify(lower), known: true }))
		.catch(() => ({ known: false, chrome: null, edge: null, chromium: null }));
}

/** 拉起浏览器时的参数。单独导出便于测试断言。 */
export function buildLaunchArgs({ port = DEFAULT_PORT, userDataDir, url = `${SITE}/web/geek/jobs` } = {}) {
	return [
		`--remote-debugging-port=${port}`,
		"--remote-allow-origins=*",
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate,OptimizationHints",
		url,
	];
}

/** 端口探测：/json/version 能出 JSON 就说明调试口在。 */
export async function probeCdp(port = DEFAULT_PORT, { fetchImpl = null, timeoutMs = 1500 } = {}) {
	const doFetch = fetchImpl ?? globalThis.fetch;
	const controller = typeof AbortController === "function" ? new AbortController() : null;
	const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await doFetch(`http://127.0.0.1:${port}/json/version`, controller === null ? {} : { signal: controller.signal });
		if (!res.ok) return { up: false, error: `HTTP ${res.status}` };
		const json = await res.json().catch(() => null);
		return { up: true, browser: json?.Browser ?? null, webSocketDebuggerUrl: json?.webSocketDebuggerUrl ?? null };
	} catch (err) {
		return { up: false, error: String(err?.name === "AbortError" ? "探测超时" : (err?.message ?? err)) };
	} finally {
		if (timer !== null) clearTimeout(timer);
	}
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 确保调试口可用：已就绪就直接用，否则依次试"能起得来"的浏览器。
 *
 * 三轮，都是**看证据**推进，不靠猜：
 *   1. 优先没在运行的浏览器 + 它自己的 profile（能带上现成登录态）；
 *   2. 第一轮全失败 → 改用**插件自己的 profile**（任何在跑的实例都不会用它，所以一定能起）；
 *   3. 还不行 → 换一个端口再试（9222 可能被别的 devtools 占着）。
 *
 * 之所以要第 2 轮：进程探测在受限环境下可能失败（Node 的管道 stdio 会被沙箱挡，
 * 报 EPERM）。"探测不到"不能当成"没在跑"—— 那会去抢用户正在用的 profile。
 * 用插件自己的目录是安全的兜底，代价只是要重新登录一次。
 *
 * @param {{ port?: number, spawnImpl?: Function, fetchImpl?: Function, waitMs?: number, url?: string, userDataDir?: string, running?: object }} [options]
 */
export async function ensureDebuggableChrome({
	port = DEFAULT_PORT,
	spawnImpl = spawn,
	fetchImpl = null,
	waitMs = LAUNCH_WAIT_MS,
	url = null,
	userDataDir = PROFILE_DIR,
	running = null,
} = {}) {
	const targetUrl = url ?? `${SITE}/web/geek/jobs`;
	const before = await probeCdp(port, { fetchImpl });
	if (before.up) return { ok: true, already: true, port, browser: before.browser };

	if (!autoChromeEnabled()) return { ok: false, port, error: "自动拉起浏览器已被 BOSS_AUTO_CHROME=0 关掉", tried: [] };

	const runningMap = running ?? await detectRunning();
	const trusted = runningMap.known === false ? {} : runningMap;
	const { all, free } = findLaunchable({ running: trusted });
	const tried = all.map((c) => {
		const key = c.name.toLowerCase();
		return `${c.name} ${c.path}${runningMap.known === false ? "（进程探测不可用）" : trusted[key] === true ? "（正在运行）" : ""}`;
	});
	if (all.length === 0) {
		return { ok: false, port, tried, error: "没找到 Chrome / Edge / Chromium 可执行文件；可用 BOSS_CHROME_PATH 指定 chrome.exe 的绝对路径。", candidates: all };
	}

	const failures = [];
	/** 记住成功的那个浏览器，下次优先它。 */
	const remember = (candidate) => { try { writeJson(chromePathFile(), { path: candidate.path, name: candidate.name, at: new Date().toISOString() }); } catch { /* 记不住也没关系 */ } };
	/** 进程探测完全不可用时，**不许**去碰真实 profile —— 宁可用插件自己的目录。 */
	const probeUnreliable = runningMap.known === false;
	if (!probeUnreliable) {
		// ① 优先"没在运行"的候选，并复用它的 profile（登录态在里面）
		for (const candidate of free) {
			const profile = userDataDirFor(candidate, trusted, userDataDir);
			const attempt = await tryLaunch({ spawnImpl, path: candidate.path, name: candidate.name, port, userDataDir: profile, url: targetUrl, waitMs, fetchImpl });
			if (attempt.ok) {
				remember(candidate);
				return { ok: true, launched: true, port, path: candidate.path, name: candidate.name, browser: attempt.browser, url: targetUrl, userDataDir: profile, reusedProfile: profile !== userDataDir };
			}
			failures.push(`${candidate.name}（${profile === userDataDir ? "插件 profile" : "浏览器 profile"}）：${attempt.error}`);
		}
	} else {
		failures.push("进程探测不可用（Node 的管道 stdio 在受限环境会被挡）—— 跳过复用浏览器 profile，直接用插件自己的目录");
	}
	// ② 用插件自己的 profile 再试一遍。这个目录不可能被任何在跑的实例占用，所以最稳。
	for (const candidate of all) {
		const attempt = await tryLaunch({ spawnImpl, path: candidate.path, name: candidate.name, port, userDataDir, url: targetUrl, waitMs, fetchImpl });
		if (attempt.ok) {
			remember(candidate);
			return { ok: true, launched: true, port, path: candidate.path, name: candidate.name, browser: attempt.browser, url: targetUrl, userDataDir, reusedProfile: false };
		}
		failures.push(`${candidate.name}（插件 profile）：${attempt.error}`);
	}
	// ③ 换个端口 —— 9222 可能被别的调试器占着
	const altPort = port === DEFAULT_PORT ? DEFAULT_PORT + 1 : DEFAULT_PORT;
	for (const candidate of all) {
		const attempt = await tryLaunch({ spawnImpl, path: candidate.path, name: candidate.name, port: altPort, userDataDir, url: targetUrl, waitMs, fetchImpl });
		if (attempt.ok) {
			remember(candidate);
			return { ok: true, launched: true, port: altPort, fallbackPort: true, path: candidate.path, name: candidate.name, browser: attempt.browser, url: targetUrl, userDataDir, reusedProfile: false };
		}
		failures.push(`${candidate.name}（端口 ${altPort}）：${attempt.error}`);
	}

	return {
		ok: false,
		port,
		tried,
		failures,
		candidates: all,
		error:
			"没能拉起任何可调试的浏览器。逐个试过的结果：\n  " + failures.join("\n  ") + "\n" +
			"最常见的原因：浏览器已经在运行 —— 已在运行的浏览器**没法**被追加调试参数（单实例语义，参数会被丢掉）。\n" +
			"可选的下一步：\n" +
			"  · 完全退出其中一个浏览器（Chrome 或 Edge），再点下面的「帮我启动浏览器」；\n" +
			"  · 或者按 README「启动真实 Chrome 会话」那节手动带 --remote-debugging-port=9222 启动。",
	};
}

/** 试一次：拉起 + 等端口。port / userDataDir 都是参数，便于多轮重试。 */
async function tryLaunch({ spawnImpl, path, name, port, userDataDir, url, waitMs, fetchImpl }) {
	let child;
	try {
		child = spawnImpl(path, buildLaunchArgs({ port, userDataDir, url }), { detached: true, stdio: "ignore", windowsHide: false });
		child?.unref?.();
	} catch (err) {
		return { ok: false, error: `启动 ${name} 失败：${String(err?.message ?? err)}` };
	}
	const deadline = Date.now() + Math.max(Number(waitMs) || 0, 1000);
	while (Date.now() < deadline) {
		await wait(300);
		const now = await probeCdp(port, { fetchImpl });
		if (now.up) return { ok: true, browser: now.browser };
	}
	return { ok: false, error: `${name} 起来了但 ${Math.round((Number(waitMs) || 0) / 1000)} 秒内 ${port} 没就绪` };
}

/**
 * 用哪个 profile。
 *
 * 那个浏览器**没在运行**时，可以安全地用它自己的默认 profile —— 用户现成的
 * Boss 登录态就在里面，省掉一次扫码。已经在跑就绝对不碰（会抢锁，而且参数会被丢掉）。
 */
export function userDataDirFor(candidate, runningMap, fallbackProfile = PROFILE_DIR) {
	const key = candidate.name.toLowerCase();
	if (runningMap?.[key] === true) return fallbackProfile;
	if (candidate.name === "自定义") return fallbackProfile;
	const real = realProfileDir(candidate.name);
	return real ?? fallbackProfile;
}

/** 浏览器默认 profile 目录（里面才有用户现成的 cookie）。 */
export function realProfileDir(name, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
	const local = env.LOCALAPPDATA ?? "";
	let dir = null;
	if (platform === "win32") {
		if (name === "Edge") dir = local ? join(local, "Microsoft", "Edge", "User Data") : null;
		else if (name === "Chrome") dir = local ? join(local, "Google", "Chrome", "User Data") : null;
	} else if (platform === "darwin") {
		if (name === "Chrome") dir = join(env.HOME ?? "", "Library/Application Support/Google/Chrome");
		else if (name === "Edge") dir = join(env.HOME ?? "", "Library/Application Support/Microsoft Edge");
	} else {
		dir = join(env.HOME ?? "", ".config", name === "Edge" ? "microsoft-edge" : "google-chrome");
	}
	// 目录不存在就别往里写：Chrome 会当成新 profile 建一堆垃圾
	return dir !== null && exists(dir) ? dir : null;
}
