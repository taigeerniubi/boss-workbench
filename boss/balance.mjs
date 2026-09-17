/**
 * 账号余额：**还剩多少钱**（不是省了多少）。
 *
 * 走 DeepSeek 官方余额接口：
 *   GET https://api.deepseek.com/user/balance    Authorization: Bearer <key>
 *   → { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *
 * 为什么必须放宿主半边：
 *   1. key 不能下发给浏览器；
 *   2. 浏览器直连 api.deepseek.com 会被 CORS 挡掉。
 *
 * 缓存 45 秒：你要"实时"，但没必要每次渲染都打一次余额接口 ——
 * 想强制刷新就在 URL 上带 `?force=1`。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENDPOINT = "https://api.deepseek.com/user/balance";
const TTL_MS = 45000;
let cache = { at: 0, value: null };

/**
 * 取 API key。先走凭据服务（正确的路），退不回就读 `~/.dsh/.credentials.yaml` 的 refs 段。
 * 只读、不外传；返回值里带了来源，方便排查"到底用的是哪个 key"。
 */
export async function resolveApiKey(ctx) {
	try {
		const credentials = ctx?.get?.("credentials");
		if (credentials !== undefined && typeof credentials.resolve === "function") {
			for (const name of ["DEEPSEEK_API_KEY", "deepseek-official"]) {
				const hit = await credentials.resolve(name);
				const value = hit?.value ?? hit?.key;
				if (typeof value === "string" && value !== "") return { key: value, from: `credentials:${name}` };
			}
		}
	} catch { /* 退回文件 */ }
	try {
		const text = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
		let inRefs = false;
		for (const line of text.split(/\r?\n/u)) {
			if (/^refs:\s*$/u.test(line)) {
				inRefs = true;
				continue;
			}
			if (inRefs && /^\S/u.test(line)) break;
			const m = inRefs ? /^\s+([A-Za-z0-9_]+):\s*(\S+)/u.exec(line) : null;
			if (m !== null && /deepseek/i.test(m[1])) return { key: m[2], from: `file:${m[1]}` };
		}
	} catch { /* 没有就没有 */ }
	return { key: null, from: null };
}

const num = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** 查余额。ok:false 也会缓存一小会儿，避免 key 失效时被反复打。 */
export async function fetchBalance(ctx, { force = false } = {}) {
	if (!force && cache.value !== null && Date.now() - cache.at < TTL_MS) return { ...cache.value, cached: true };
	const { key, from } = await resolveApiKey(ctx);
	if (key === null) {
		return { ok: false, error: "没找到 DeepSeek API key（credentials 与 ~/.dsh/.credentials.yaml 都没有）", at: new Date().toISOString() };
	}
	try {
		const res = await fetch(ENDPOINT, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } });
		const text = await res.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch { /* 非 JSON */ }
		if (!res.ok) {
			const value = { ok: false, error: `HTTP ${res.status} ${json?.error?.message ?? text.slice(0, 120)}`, at: new Date().toISOString() };
			cache = { at: Date.now(), value };
			return value;
		}
		const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : [];
		const first = infos[0] ?? null;
		const value = {
			ok: true,
			from,
			available: json?.is_available === true,
			currency: first?.currency ?? "CNY",
			total: num(first?.total_balance),
			granted: num(first?.granted_balance),
			toppedUp: num(first?.topped_up_balance),
			all: infos.map((b) => ({ currency: b.currency, total: num(b.total_balance) })),
			at: new Date().toISOString(),
		};
		cache = { at: Date.now(), value };
		return value;
	} catch (err) {
		return { ok: false, error: `请求失败: ${String(err.message).split("\n")[0]}`, at: new Date().toISOString() };
	}
}

/** 钱怎么显示：CNY 用 ¥，USD 用 $，其它带代码。 */
export function formatMoney(amount, currency = "CNY") {
	if (amount === null || amount === undefined) return "—";
	const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
	return `${symbol}${amount.toFixed(2)}`;
}
