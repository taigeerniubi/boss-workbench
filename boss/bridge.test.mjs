/**
 * 桥的自检：对着**正在运行**的 GUI 打 /boss 的四个端点。
 *
 * 用 client-connection 持久化的签名密钥自签一个等价 cookie（和 inspect-gui.mjs 同样的做法），
 * 这样测的是真实的鉴权路径，而不是绕过它。
 *
 * 用法： node boss/bridge.test.mjs
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const ORIGIN = "http://127.0.0.1:3080";
const HOST = "127.0.0.1:3080";

const cred = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, "utf8");
const secret = Buffer.from(cred.match(/secret:\s*([A-Za-z0-9_-]+)/)[1].replaceAll("-", "+").replaceAll("_", "/"), "base64");
const b64u = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const issuedAt = Date.now();
const expiresAt = issuedAt + 30 * 86400 * 1000;
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority: HOST, issuedAt, expiresAt }), "utf8"));
const cookie = `dsh-auth-${b64u(createHash("sha256").update(HOST).digest())}=v1.${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;

const fail = [];
const check = (ok, msg) => {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`);
	if (!ok) fail.push(msg);
};
const call = async (path, init = {}, withCookie = true) => {
	const res = await fetch(ORIGIN + path, { ...init, headers: { ...(withCookie ? { cookie } : {}), ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(init.headers ?? {}) } });
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch { /* 非 JSON 就留着 text */ }
	return { status: res.status, json, text };
};

console.log(`目标: ${ORIGIN}/boss/*\n`);

console.log("── 1. 鉴权：不带 cookie 必须被挡 ──");
const anon = await call("/boss/state", {}, false);
check(anon.status === 401, `无 cookie → ${anon.status}（期望 401）`);

console.log("\n── 2. GET /boss/state ──");
const state = await call("/boss/state");
if (state.status === 404) {
	console.log(`  404 —— /boss 路由还没挂上。`);
	console.log(`  原因：宿主半边（plugin/lib/index.js）是 GUI 启动时加载的，改完必须让插件重载，`);
	console.log(`        普通刷新页面只换客户端半边，换不掉宿主半边。`);
	console.log(`  解决：重启一次 DSH Web GUI，然后重跑本脚本。`);
	console.log(`  （试过往 profile 的 cordis.patch.yml 追加注释来触发 live reload —— 无效，别白试。）`);
	console.log(`\n结论：桥的代码已通过语法检查与离线渲染，但**未在运行时验证**。`);
	process.exit(2); // 2 = 未验证（不是失败，也不是通过）
}
check(state.status === 200, `HTTP ${state.status}`);
check(state.json?.ok === true, "ok:true");
check(state.json?.resumes !== undefined, `带上了简历索引（${state.json?.resumes?.count ?? 0} 份，成功解析 ${state.json?.resumes?.parsed ?? 0}）`);
check(Array.isArray(state.json?.jobs), `带上了岗位列表（${state.json?.jobs?.length ?? 0} 条）`);
check(state.json?.profile?.homeCity !== undefined, `带上了 profile（homeCity=${state.json?.profile?.homeCity}）`);
check(state.json?.session !== undefined, `带上了登录态（present=${state.json?.session?.present}）`);
console.log(`     简历库目录: ${state.json?.resumesDir}`);
if ((state.json?.resumes?.count ?? 0) > 0) {
	const f = state.json.resumes.files[0];
	console.log(`     第一份: ${f.name}  status=${f.status}  技能=${f.structured?.skills?.length ?? 0} 项  yoe=${f.structured?.yoe ?? "?"}`);
}

console.log("\n── 3. POST /boss/resumes/rescan ──");
const rescan = await call("/boss/resumes/rescan", { method: "POST", body: "{}" });
check(rescan.status === 200 && rescan.json?.ok === true, `HTTP ${rescan.status} ok=${rescan.json?.ok}`);

console.log("\n── 4. POST /boss/greet/preview（应当优雅报错，而不是 500）──");
const preview = await call("/boss/greet/preview", { method: "POST", body: JSON.stringify({ jobId: "no-such-job" }) });
check(preview.status === 400 || preview.status === 404, `HTTP ${preview.status}（期望 400/404）`);
check(typeof preview.json?.error === "string" && preview.json.error !== "", `给了原因："${preview.json?.error}"`);

console.log("\n── 5. 上传端点存在性（发一个空 body，期望 400 而不是 404）──");
const up = await call("/boss/resumes/upload?name=probe.txt", { method: "POST", body: "" });
check(up.status !== 404, `HTTP ${up.status}（不等于 404 即路由存在）`);

console.log("\n── 6. POST /boss/scrape（工作台「搜」按钮打的就是它）──");
// 刻意用一个不存在的城市：resolveCity 会当场返回 null，
// runScrape 在联网之前就带着 no-city 退出。所以这一发**不会碰 Boss**，
// 只验证路由在不在、参数链路通不通。
const scrape = await call("/boss/scrape", { method: "POST", body: JSON.stringify({ mode: "search", city: "这个城市不存在", query: "Java", pages: 1 }) });
if (scrape.status === 404) {
	check(false, "/boss/scrape 路由不存在 —— 宿主半边还是旧的，重启一次 DSH GUI");
} else {
	check(scrape.status === 200, `HTTP ${scrape.status}`);
	check(scrape.json?.reason === "no-city", `联网前就挡住了：reason=${scrape.json?.reason}（"${scrape.json?.error}"）`);
	check(scrape.json?.ok === false, "ok:false 而不是抛 500");
	check(Array.isArray(scrape.json?.jobs), "即使没抓到，也把库里的岗位带回来了（客户端不用二次往返）");
}

console.log(`\n${fail.length === 0 ? "全部通过 ✅" : `${fail.length} 项失败 ❌`}`);
process.exit(fail.length === 0 ? 0 : 1);
