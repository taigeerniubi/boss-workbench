/**
 * 扫码后卡住 —— 定位到底卡在哪一步。
 *
 * 做法：先问宿主 /boss/login/* 现在是什么状态，再**绕过宿主的判断**，
 * 直接拿这个 qrId 去问 Boss 的 scan / scanLogin，把原始响应打出来 ——
 * 因为最可能的错因是我把字段名猜错了（比如 scaned 在 zpData 里而不是顶层）。
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const HOST = "127.0.0.1:3080";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

const cred = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, "utf8");
const secret = Buffer.from(cred.match(/secret:\s*([A-Za-z0-9_-]+)/)[1].replaceAll("-", "+").replaceAll("_", "/"), "base64");
const b64u = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const issuedAt = Date.now();
const expiresAt = issuedAt + 30 * 86400 * 1000;
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority: HOST, issuedAt, expiresAt }), "utf8"));
const cookie = `dsh-auth-${b64u(createHash("sha256").update(HOST).digest())}=v1.${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;

const call = async (path, init = {}) => {
	const res = await fetch(`http://${HOST}${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch { /* 非 JSON */ }
	return { status: res.status, json, text: text.slice(0, 300) };
};

console.log("══ 1. 宿主的登录状态 ══");
const st = await call("/boss/login/state");
console.log(`  /boss/login/state → HTTP ${st.status}`, JSON.stringify(st.json ?? st.text).slice(0, 200));
const flow = await call("/boss/login/status");
console.log(`  /boss/login/status → HTTP ${flow.status}`, JSON.stringify(flow.json ?? flow.text).slice(0, 300));

const qrId = flow.json?.qrId ?? null;
if (qrId === null) {
	console.log("\n  ⚠ 宿主里没有进行中的登录流程（qrId 为空）。");
	console.log("    意味着：你看到的二维码不是这个进程发出的，或者宿主在那之后又重载过（内存里的 flow 丢了）。");
	process.exit(0);
}
console.log(`\n  宿主记着的 qrId = ${qrId}  phase = ${flow.json?.phase}`);

console.log("\n══ 2. 绕过宿主，直接问 Boss（看字段真名）══");
const raw = async (label, url) => {
	try {
		const res = await fetch(url, { headers: { "user-agent": UA, referer: "https://www.zhipin.com/web/user/?ka=header-login" }, signal: AbortSignal.timeout(9000) });
		const text = await res.text();
		console.log(`  ${label} → HTTP ${res.status}`);
		console.log(`    原始响应: ${text.slice(0, 400)}`);
		return text;
	} catch (err) {
		console.log(`  ${label} → ✗ ${String(err.message).split("\n")[0]}（长轮询超时是正常的，说明还没扫到）`);
		return null;
	}
};
await raw("scan（等扫码）", `https://www.zhipin.com/wapi/zppassport/qrcode/scan?uuid=${encodeURIComponent(qrId)}&_=${Date.now()}`);
await raw("scanLogin（等确认）", `https://www.zhipin.com/wapi/zppassport/qrcode/scanLogin?qrId=${encodeURIComponent(qrId)}&status=1&_=${Date.now()}`);

console.log("\n══ 3. 结论怎么看 ══");
console.log("  · 若 scan 回的是 {\"scaned\":true,...} 顶层字段 → 我的判断字段是对的，问题在别处（比如客户端没在轮询）");
console.log("  · 若 scan 回的是 {\"code\":0,\"zpData\":{\"scaned\":true}} → 字段在 zpData 里，我的 r.json?.scaned 永远是 undefined，卡住");
console.log("  · 若两个都超时 → 那次扫码没被 Boss 记到这个 qrId 上（二维码过期/扫的不是这张）");
