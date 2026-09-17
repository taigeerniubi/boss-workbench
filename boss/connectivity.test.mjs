/**
 * 联通性一次测四件事：
 *   1. 代理/梯子到底有没有生效（环境变量 / 注册表 / 常见本地端口）
 *   2. Boss 的 IP 风控（code 35）还在不在 —— 这是能不能抓取的总开关
 *   3. 宿主那座桥（/boss/*）起没起 —— 起了才谈得上 UI 里出二维码
 *   4. DeepSeek 余额接口
 *
 * 只读：GET 首页与 header.json，不登录、不投递、不改任何东西。
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const HOST = "127.0.0.1:3080";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

//#region 1. 代理探测
console.log("══ 1. 代理 / 梯子 ══");
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "NO_PROXY"]) {
	if (process.env[k] !== undefined) console.log(`  环境变量 ${k} = ${process.env[k]}`);
}
try {
	const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8" });
	for (const line of out.split(/\r?\n/u)) {
		if (/ProxyEnable|ProxyServer|AutoConfigURL/u.test(line)) console.log("  注册表 " + line.trim().replace(/\s{2,}/gu, " "));
	}
} catch (err) {
	console.log("  注册表读不到:", String(err.message).split("\n")[0]);
}
try {
	const net = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
	const ports = new Set();
	for (const line of net.split(/\r?\n/u)) {
		const m = /^\s+TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/u.exec(line);
		if (m !== null && ["7890", "7891", "7897", "7899", "1080", "1081", "10808", "10809", "20171", "2080"].includes(m[1])) ports.add(m[1]);
	}
	console.log("  本地代理端口监听中:", ports.size === 0 ? "（没发现常见代理端口）" : [...ports].join(", "));
} catch { /* netstat 不可用就算了 */ }
//#endregion

//#region 2. Boss 可达性 + 风控码
console.log("\n══ 2. Boss 直聘 ══");
const probe = async (label, url) => {
	try {
		const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json, text/plain, */*" }, redirect: "manual" });
		const text = await res.text();
		const wall = /安全验证|异常访问/u.test(text) || /verify\.html/u.test(res.headers.get("location") ?? "");
		let code = null;
		let msg = null;
		try {
			const j = JSON.parse(text);
			code = j.code ?? null;
			msg = j.message ?? null;
		} catch { /* 非 JSON */ }
		console.log(`  ${label}: HTTP ${res.status}${wall ? "  ⚠ 安全验证页" : ""}${code !== null ? `  code=${code}` : ""}${msg !== null ? `  ${msg}` : ""}`);
		return { status: res.status, code, msg, wall, text };
	} catch (err) {
		console.log(`  ${label}: ✗ ${String(err.message).split("\n")[0]}`);
		return { error: String(err.message) };
	}
};
const home = await probe("首页", "https://www.zhipin.com/");
const header = await probe("header.json", "https://www.zhipin.com/wapi/zpgeek/common/data/header.json?_=" + Date.now());
if (header.code === 35) console.log("  → 结论：IP 仍在风控名单上（code 35）");
else if (header.code === 0) {
	const m = /isLogin:\s*(true|false)/u.exec(header.text ?? "");
	console.log(`  → 结论：风控已解除，接口可用；登录态 isLogin=${m?.[1] ?? "?"}`);
} else if (home.error !== undefined) console.log("  → 结论：连不上（代理可能只代理了浏览器，没代理 node）");
//#endregion

//#region 3. 桥
console.log("\n══ 3. 宿主桥 /boss/* ══");
const cred = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, "utf8");
const secret = Buffer.from(cred.match(/secret:\s*([A-Za-z0-9_-]+)/)[1].replaceAll("-", "+").replaceAll("_", "/"), "base64");
const b64u = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const issuedAt = Date.now();
const expiresAt = issuedAt + 30 * 86400 * 1000;
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority: HOST, issuedAt, expiresAt }), "utf8"));
const cookie = `dsh-auth-${b64u(createHash("sha256").update(HOST).digest())}=v1.${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;
try {
	const res = await fetch(`http://${HOST}/boss/state`, { headers: { cookie } });
	if (res.status === 404) console.log("  ✗ 404 —— 宿主半边还没重载（重启一次 DSH GUI 才会挂上 /boss）");
	else {
		const j = await res.json();
		console.log(`  ✓ HTTP ${res.status}  ok=${j.ok}  简历 ${j.resumes?.count ?? 0} 份  岗位 ${j.jobs?.length ?? 0} 条  登录态 ${j.session?.present ? "有会话文件" : "无"}`);
	}
} catch (err) {
	console.log("  ✗", String(err.message).split("\n")[0]);
}
//#endregion

//#region 4. 余额
console.log("\n══ 4. DeepSeek 余额 ══");
try {
	const { fetchBalance, formatMoney } = await import("./balance.mjs");
	const r = await fetchBalance({ get: () => undefined }, { force: true });
	console.log(r.ok ? `  ✓ ${formatMoney(r.total, r.currency)}（赠送 ${r.granted} / 充值 ${r.toppedUp}）` : `  ✗ ${r.error}`);
} catch (err) {
	console.log("  ✗", String(err.message).split("\n")[0]);
}
//#endregion
