/**
 * 找到 Playwright —— 别把开发机的绝对路径写死在代码里。
 *
 * 原来每个脚本都是 `import { chromium } from "file:///D:/opencode/node_modules/playwright/index.mjs"`，
 * 在别人的机器上必然 ENOENT。这里按"正常安装优先、开发机的兜底放最后"的顺序找，
 * 并且**懒加载**：只用 HTTP 的那半（抓岗位 / 简历解析 / 余额）根本不需要 Playwright，
 * 没装也不该 import 就炸。
 *
 * 想显式指定：`set BOSS_PLAYWRIGHT=playwright`（或某个 index.mjs 的绝对路径）。
 */
const CANDIDATES = [
	process.env.BOSS_PLAYWRIGHT,
	"playwright",
	"playwright-core",
	// 开发机（D:\opencode）上那份。放最后：只有在别的都找不到时才用它。
	"file:///D:/opencode/node_modules/playwright/index.mjs",
];

let cached = null;

/** @returns {Promise<import("playwright").BrowserType>} */
export async function loadChromium() {
	if (cached !== null) return cached;
	const tried = [];
	for (const spec of CANDIDATES) {
		if (typeof spec !== "string" || spec === "") continue;
		try {
			const mod = await import(spec);
			if (mod?.chromium !== undefined) {
				cached = mod.chromium;
				return cached;
			}
			tried.push(`${spec} —— 模块在，但没有导出 chromium`);
		} catch (err) {
			tried.push(`${spec} —— ${String(err?.code ?? err?.message ?? err).slice(0, 70)}`);
		}
	}
	throw new Error(
		"找不到 Playwright。它在整个链路里只负责一件事：过 Boss 的安全验证、拿 __zp_stoken__。\n" +
			"  装法：  npm i -D playwright  &&  npx playwright install chromium\n" +
			"  或指定：set BOSS_PLAYWRIGHT=<路径>\n" +
			"试过这些地方：\n  " +
			tried.join("\n  "),
	);
}

export const hasPlaywright = () => cached !== null;
