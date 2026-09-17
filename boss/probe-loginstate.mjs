/**
 * 把 header.json 的完整 zpData 落盘，确认 isLogin 到底是 true 还是 false。
 *
 * 只读一个登录态接口（不碰岗位接口，不碰搜索），一次请求。
 *   node boss/probe-loginstate.mjs
 */
import { join } from "node:path";
import { RUNS_DIR, httpApi, isFlagged, loadSession, loginStateHttp, writeJson } from "./lib.mjs";

const session = loadSession();
if (session === null) {
	console.error("没有 data/session.json");
	process.exit(1);
}

const r = await httpApi("/wapi/zpgeek/common/data/header.json", {}, session);
const html = typeof r.json?.zpData === "string" ? r.json.zpData : "";
const hits = [...html.matchAll(/isLogin\s*:\s*([^,\n}]+)/gu)].map((m) => m[1].trim());
writeJson(join(RUNS_DIR, "loginstate-probe.json"), {
	at: new Date().toISOString(),
	httpStatus: r.status,
	code: r.json?.code,
	message: r.json?.message,
	flagged: isFlagged(r.json),
	isLoginHits: hits,
	cookieNames: session.cookie.split("; ").map((p) => p.split("=")[0]),
	zpDataLen: html.length,
	zpData: html,
});
console.log(`HTTP ${r.status} code=${r.json?.code} message=${r.json?.message}`);
console.log(`isLogin 出现 ${hits.length} 次: ${JSON.stringify(hits)}`);
console.log(`cookie: ${session.cookie.split("; ").map((p) => p.split("=")[0]).join(", ")}`);
console.log(`\n判定: ${JSON.stringify(await loginStateHttp(session))}`);
console.log(`\n完整 html 已落盘 runs/loginstate-probe.json`);
