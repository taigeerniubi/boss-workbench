/**
 * 把参考仓库的源码拉到本地，便于本地检索（避免把 48KB Python 全量读进上下文）。
 * 只下载公开的 raw 文件，不执行、不调用它的任何服务。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "ref", "mcp-bosszp");
mkdirSync(OUT, { recursive: true });

const BASE = "https://raw.githubusercontent.com/mucsbr/mcp-bosszp/main/";
const FILES = ["boss_zhipin_fastmcp_v2.py", "login_verifier.py", "requirements.txt", "CLAUDE.md", "CLAUDE_CONFIG.md", "Dockerfile"];

for (const f of FILES) {
	try {
		const res = await fetch(BASE + f, { headers: { "user-agent": "dsh-boss-workbench-study" } });
		if (!res.ok) {
			console.log(`  ✗ ${f}  HTTP ${res.status}`);
			continue;
		}
		const text = await res.text();
		writeFileSync(join(OUT, f), text, "utf8");
		console.log(`  ✓ ${f}  ${text.length} 字节  → ref/mcp-bosszp/${f}`);
	} catch (err) {
		console.log(`  ✗ ${f}  ${String(err.message).split("\n")[0]}`);
	}
}
console.log(`\n落地目录: ${OUT}`);
