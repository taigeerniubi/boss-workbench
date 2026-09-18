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
 * 探测浏览器现在有没有在跑。
 *
 * **不走 `tasklist`/`ps`**：在受限环境里 spawn 一个带管道的子进程会被挡掉
 *（Node 在 Windows 上给管道开的是命名管道，沙箱直接 EPERM）。实测过
 * `execFile` 和"重定向到文件"两种写法都一样，所以不能依赖这条路。
 *
 * 改用**profile 加锁**这个纯文件系统判据 —— 浏览器运行时会锁住 profile 目录下的
 * `lockfile`（注意不是 `LOCK`，这个文件名我在本机确认过）：
 *   - 能拿到写句柄 → 没在跑
 *   - 拿不到（EPERM/EBUSY）→ 正在跑
 * 本机实测：Chrome（27 进程）与 Edge（8 进程）的 lockfile 都是 EPERM，判据成立。
 *
 * @returns {Promise<{known: boolean, chrome: boolean|null, edge: boolean|null, chromium: boolean|null}>}
 */
export async function detectRunning({ platform = process.platform, env = process.env, browserCandidates: candidates = null } = {}) {
	const { openSync, closeSync, existsSync: exists = existsSync } = await import("node:fs");
	const { join: joinPath } = await import("node:path");
	/**
	 * 某个 profile 目录是不是"正在被使用"。
	 * 拿不到写句柄 = 在跑；文件不存在 = 判不了（返回 null，让调用方按"在用"处理）。
	 */
	const inUse = (profileDir) => {
		if (profileDir === null || profileDir === undefined || !exists(profileDir)) return null;
		for (const name of ["lockfile", "LOCK"]) {
			const lock = joinPath(profileDir, name);
			if (!exists(lock)) continue;
			let fd = null;
			try {
				fd = openSync(lock, "r+");
				return false; // 拿到了 → 没在跑
			} catch {
				return true; // 拿不到 → 有人正开着
			} finally {
				if (fd !== null) { try { closeSync(fd); } catch { /* 忽略 */ } }
			}
		}
		return null;
	};
	const list = candidates ?? browserCandidates({ env, exists, platform });
	const result = { chrome: null, edge: null, chromium: null };
	let anyKnown = false;
	const seen = new Set();
	for (const candidate of list) {
		const key = candidate.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const value = inUse(realProfileDir(candidate.name, { env, platform, exists }));
		if (value === null) continue;
		anyKnown = true;
		// 同一个 name 可能有多个可执行文件路径，取"或"：任一个在用就算在用
		result[key] = result[key] === true ? true : value;
	}
	return { ...result, known: anyKnown };
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
 * 确保调试口可用：已就绪就直接用，否则拉起一个带调试口的浏览器。
 *
 * ## 用哪个 user-data-dir（这一条最关键）
 *
 * 一律用**插件自己的 profile**（`~/.dsh/boss-workbench/browser-profile`），理由三条：
 *   1. 它**不是默认 profile**。Chrome 136+ 开始，远程调试在默认 profile 上被官方禁掉，
 *      只有非默认 `--user-data-dir` 才有效 —— 这条正好绕开。
 *   2. 它**不可能被用户在跑的实例占用**，所以不会撞上"单实例合并、参数被丢掉"。
 *   3. 它里面已经有登录过 Boss 的痕迹（`session.json` 里 `stoken: present` 就是那一次写的），
 *      冷启动后常常直接就是登录态 —— 用户连扫码都省了。
 *
 * 反过来说：**不去复用浏览器日常的那个 profile**。那是默认 profile，既可能被 Chrome
 * 的策略挡住，也可能和用户正在用的实例抢锁；代价只是"可能要重新登录一次"，比出问题好。
 *
 * ## 关于"浏览器已经在跑"
 *
 * 加了 `--user-data-dir` 之后是一个**独立实例**，不会和用户正在跑的那个合并，
 * DSH 所在的 Chrome 也完全不受影响。进程退出时留下的 profile 是新建的，不动用户的。
 *
 * ## 三轮尝试
 *   1. 首选候选 + 插件 profile
 *   2. 其余候选（Chrome/Edge/Chromium 各试一遍）
 *   3. 换个端口再试（9222 可能被别的调试器占着）
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
	const { all, free } = findLaunchable({ running: runningMap.known === false ? {} : runningMap });
	const tried = all.map((c) => {
		const key = c.name.toLowerCase();
		return `${c.name} ${c.path}${runningMap.known === false ? "（占用探测不可用）" : runningMap[key] === true ? "（正在运行）" : ""}`;
	});
	if (all.length === 0) {
		return { ok: false, port, tried, error: "没找到 Chrome / Edge / Chromium 可执行文件；可用 BOSS_CHROME_PATH 指定 chrome.exe 的绝对路径。", candidates: all };
	}

	// 先试"当前没在跑"的候选（更干净），再试其余的；都用插件自己的 profile。
	const ordered = [...free, ...all.filter((c) => !free.includes(c))];
	const failures = [];
	const remember = (candidate) => { try { writeJson(chromePathFile(), { path: candidate.path, name: candidate.name, at: new Date().toISOString() }); } catch { /* 记不住也没关系 */ } };

	for (const candidate of ordered) {
		const attempt = await tryLaunch({ spawnImpl, path: candidate.path, name: candidate.name, port, userDataDir, url: targetUrl, waitMs, fetchImpl });
		if (attempt.ok) {
			remember(candidate);
			return { ok: true, launched: true, port, path: candidate.path, name: candidate.name, browser: attempt.browser, url: targetUrl, userDataDir, reusedProfile: false };
		}
		failures.push(`${candidate.name}（端口 ${port}）：${attempt.error}`);
	}
	// 换个端口 —— 9222 可能被别的调试器占着
	const altPort = port === DEFAULT_PORT ? DEFAULT_PORT + 1 : DEFAULT_PORT;
	for (const candidate of ordered) {
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
			`用的 profile 是 ${userDataDir}（插件自己的目录，不是浏览器默认 profile）。\n` +
			"可选的下一步：\n" +
			"  · 确认那个浏览器的窗口确实弹出来了（任务栏可能被最小化/藏到后台）；\n" +
			"  · 或用 BOSS_CHROME_PATH 指定另一个浏览器可执行文件后重试；\n" +
			"  · 或按 README「启动真实 Chrome 会话」那节手动带 --remote-debugging-port=9222 启动。",
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
