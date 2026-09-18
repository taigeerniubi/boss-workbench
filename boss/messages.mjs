/**
 * 会话读取（求职端）。
 *
 * 这里每一步的路径、参数名、响应字段名都来自 zhipin-geek（求职端 CLI）
 * `boss_cli/client.py` 里那份**已在真实账号跑通**的实现：
 *
 *   ① `POST /wapi/zprelation/friend/geekFilterByLabel`  form: labelId, page
 *        → zpData.friendList[]：friendId / name / brandName / jobName /
 *          encryptJobId / securityId / lastMsg / lastTS / unreadMsgCount
 *   ② `GET  /wapi/zpchat/geek/userLastMsg?friendIds=1,2,3`（逗号分隔，**每批 ≤20**）
 *        → zpData[]：{ uid（永远是"我"）, lastTime, lastMsgInfo:{ msgId, fromId, toId, showText } }
 *   ③ `GET  /wapi/zpchat/geek/getBossData?bossId=<friendId>`
 *        → zpData.data.securityId（historyMsg 必须带它）
 *   ④ `GET  /wapi/zpchat/geek/historyMsg?gid=&c=&src=0&securityId=[&maxMsgId=]`
 *        → zpData.{messages|msgList}[]：{ mid, received, from:{uid,name}, to:{uid}, body:{type,text,jobDesc}, time }
 *
 * 与上一版的差别（都是会让功能静默失效的真 bug）：
 *   - 「最近消息」原来一步就够的判断错了：`friendList` 每条**自带** `lastMsg`，
 *     但要判断"最后一条是不是 Boss 发的、要不要我回"仍需 ②（它给 fromId/toId），
 *     而 ② 每批最多 20 个 friendId，超了要分批 —— 原来一次把 100 个塞进一个 query。
 *   - 判断"谁是我"用 ② 里的 `uid` 字段，而不是猜第一条消息的 fromId。
 *   - 历史消息翻页游标是 `maxMsgId` + 返回的 `minMsgId`，原来完全没翻页。
 *   - 消息正文在 `body.text`，非文本消息看 `body.type`（8=职位卡片）。
 */
import { join } from "node:path";
import { browserJson, classifyBossResponse, connectExistingBossBrowser } from "./browser-channel.mjs";
import { DATA_DIR, markCooldown, readJson, writeJson } from "./lib.mjs";
import { ChatSendError, sendChatMessage } from "./mqtt-chat.mjs";

export const FRIEND_LIST_PATH = "/wapi/zprelation/friend/geekFilterByLabel";
export const LAST_MESSAGES_PATH = "/wapi/zpchat/geek/userLastMsg";
export const BOSS_DATA_PATH = "/wapi/zpchat/geek/getBossData";
export const HISTORY_PATH = "/wapi/zpchat/geek/historyMsg";
export const USER_INFO_PATH = "/wapi/zpuser/wap/getUserInfo.json";
/** MQTT 的 wt2 不在 cookie 里，要单独问一次。 */
export const WS_TOKEN_PATH = "/wapi/zppassport/get/wt";

/** 两条消息之间的最小间隔。Boss 的风控是按频率扣分的，发消息也不例外。 */
export const MIN_REPLY_INTERVAL_MS = 3000;
/** 同一个人、同样的文本，在这个窗口内不重复发 —— 防手抖双击、防脚本重放。 */
export const DUPLICATE_WINDOW_MS = 120000;
const SEND_LOG = () => join(DATA_DIR, "sent-messages.json");

/** userLastMsg 每批最多带 20 个 friendId（接口上限，超了会被截断）。 */
export const FRIEND_BATCH = 20;
/** historyMsg 单页上限。 */
export const HISTORY_PAGE_SIZE = 20;
/** 一次"读取会话"最多翻几页历史 —— 硬顶，避免变成无界翻页。 */
export const MAX_HISTORY_PAGES = 5;

const CHAT_REFERER = "https://www.zhipin.com/web/geek/chat";
const SITE_ORIGIN = "https://www.zhipin.com";

const responseData = (json) => json?.zpData ?? json?.data ?? {};
/**
 * 一次读取的会话上限。`userLastMsg` 每批只吃 20 个 friendId，所以 20 以上会真的分批，
 * 这里给到 30 是为了让"分批"这条路在真实使用里会走到（UI 也按这个上限展示）。
 */
export const MAX_THREADS = 30;
/** 单次列表请求从 Boss 拿多少条草稿。列表接口本身按页给，取一页就够。 */
const LIST_FETCH = 30;
const listFrom = (data, keys) => {
	if (Array.isArray(data)) return data;
	for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
	return [];
};
const uidOf = (value) => Number(value?.uid ?? value?.userId ?? value ?? 0) || 0;
const chunk = (items, size) => {
	const out = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
};

/** Boss 消息体 type → 中文占位（8=职位卡片，2=图片，3=语音）。 */
function bodyText(body, item) {
	const direct = item?.text ?? body?.text ?? body?.showText ?? item?.showText;
	if (typeof direct === "string" && direct !== "") return direct;
	const type = Number(body?.type ?? item?.type ?? 0);
	if (type === 8) return `[职位卡片] ${body?.jobDesc?.title ?? body?.jobDesc?.jobName ?? "未知职位"}`;
	if (type === 2) return "[图片]";
	if (type === 3) return "[语音]";
	if (type === 4) return "[附件简历]";
	if (type === 5) return "[交换联系方式]";
	return type === 0 ? "" : `[消息类型 ${type}]`;
}

/** 时间戳：Boss 给的是毫秒；也给"已经是 ISO 字符串"的响应留一条路。 */
function toIso(rawTime) {
	const n = Number(rawTime);
	if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
	return typeof rawTime === "string" && rawTime !== "" ? rawTime : null;
}

/**
 * 把 historyMsg 的原始条目规范化成时间正序。
 * @param {object[]} items
 * @param {{ myUid?: number }} [options]
 */
export function normalizeChatMessages(items, { myUid = 0 } = {}) {
	return (items ?? []).map((item) => {
		const fromId = uidOf(item.from ?? item.fromId);
		const toId = uidOf(item.to ?? item.toId);
		// `received === true` 表示"我收到的"，即对方发的。Boss 自己带这个字段，
		// 比拿 uid 对比可靠（uid 拿不到时也不会把方向搞反）。
		const direction = item.received === true ? "incoming"
			: item.received === false ? "outgoing"
				: fromId !== 0 && myUid !== 0 ? (fromId === Number(myUid) ? "outgoing" : "incoming")
					: "incoming";
		const body = item.body ?? {};
		const text = bodyText(body, item);
		const rawTime = item.time ?? item.msgTime ?? item.timestamp ?? item.createTime ?? item.ts ?? 0;
		return {
			id: String(item.mid ?? item.msgId ?? item.id ?? `${fromId}-${rawTime}`),
			direction,
			fromId,
			toId,
			fromName: item.from?.name ?? "",
			text,
			at: toIso(rawTime),
			type: Number(body.type ?? item.type ?? 1),
		};
	}).filter((message) => message.text !== "").sort((a, b) => String(a.at ?? a.id).localeCompare(String(b.at ?? b.id)));
}

/** 会话阶段与"是否需要我回"。 */
export function summarizeConversation(messages) {
	const all = messages ?? [];
	const latest = all.at(-1) ?? null;
	const text = all.map((message) => message.text).join(" ");
	let stage = "new";
	let nextAction = "review";
	if (/面试|约个面|视频面|到面|面谈/u.test(text)) { stage = "interview"; nextAction = "confirm-interview"; }
	else if (/薪资|工资|期望薪酬|目前薪酬|待遇/u.test(text)) { stage = "salary"; nextAction = latest?.direction === "incoming" ? "reply" : "wait"; }
	else if (/简历|附件/u.test(text)) { stage = "resume"; nextAction = latest?.direction === "incoming" ? "reply" : "wait"; }
	else if (latest !== null) { stage = latest.direction === "incoming" ? "reply-needed" : "waiting"; nextAction = latest.direction === "incoming" ? "reply" : "wait"; }
	return {
		stage,
		nextAction,
		needsReply: latest?.direction === "incoming",
		messageCount: all.length,
		lastText: latest?.text ?? "",
		facts: [
			text.includes("微信") ? "涉及微信" : null,
			text.includes("简历") ? "涉及简历" : null,
			/面试|约个面/u.test(text) ? "涉及面试" : null,
		].filter(Boolean),
	};
}

export function normalizeThread(friend, lastMessage, myUid) {
	const friendId = Number(friend.friendId ?? friend.gid ?? friend.id ?? 0);
	const info = lastMessage?.lastMsgInfo ?? lastMessage ?? {};
	const fromId = Number(info.fromId ?? 0);
	const toId = Number(info.toId ?? 0);
	// 对端 = 两边里不是"我"的那个；拿不到 uid 时退回 friendId。
	const peer = myUid !== 0 ? (fromId === Number(myUid) ? toId : fromId) : fromId || friendId;
	return {
		friendId,
		peerId: peer,
		bossName: friend.name ?? friend.bossName ?? "",
		company: friend.brandName ?? friend.companyName ?? "",
		jobName: friend.jobName ?? friend.jobTitle ?? "",
		encryptJobId: friend.encryptJobId ?? friend.jobId ?? "",
		securityId: friend.securityId ?? "",
		encryptFriendId: friend.encryptFriendId ?? "",
		lastText: info.showText ?? info.text ?? friend.lastMsg ?? "",
		lastTime: lastMessage?.lastTime ?? friend.lastTS ?? friend.lastTime ?? null,
		unread: Number(friend.unreadMsgCount ?? 0) || 0,
		lastMessageId: info.msgId ?? null,
		needsReply: fromId !== 0 && myUid !== 0 ? fromId !== Number(myUid) : false,
		// friendList 自带的这一条消息文本，②拿不到时的兜底展示
		listLastText: friend.lastMsg ?? "",
	};
}

async function defaultRequest(path, params, options) {
	// autoLaunch：那个窗口被关掉之后，读会话/发消息也该能自己再拉一个。
	const linked = await connectExistingBossBrowser({ autoLaunch: true });
	if (!linked.loggedIn) throw new Error("那个浏览器里的 Boss 登录态已失效，请在弹出的窗口里重新登录");
	return browserJson(linked.page, path, params, options);
}

function checked(response, action) {
	const state = classifyBossResponse(response.json, response);
	if (state.kind === "success") return responseData(response.json);
	if (["ip-risk", "account-risk", "environment-risk", "browser-blocked", "rate-limited"].includes(state.kind)) {
		markCooldown({ kind: state.kind, message: `${action}终止：${response.json?.message ?? state.kind}` });
	}
	const error = new Error(response.json?.message ?? `${action}失败：${state.kind}`);
	error.code = state.kind;
	throw error;
}

/** 读一次"我是谁"。所有会话判断（哪边是对方）都要它，所以单独一步、可缓存。 */
export async function fetchMyUid({ transport = null } = {}) {
	const request = transport?.request ?? defaultRequest;
	const response = await request(USER_INFO_PATH, {}, { referer: "https://www.zhipin.com/" });
	const data = checked(response, "获取我的账号信息");
	const uid = Number(data.userId ?? data.uid ?? 0) || 0;
	return { uid, encryptUid: data.encryptUserId ?? "", name: data.name ?? "" };
}

/**
 * 步骤 ①②：会话列表 + 每个会话的最近一条消息。
 * 总共 **1 次列表请求 + ceil(n/20) 次最近消息请求**，不做隐式翻页或重试。
 */
export async function fetchMessageThreads({ count = 20, myUid = 0, transport = null, save = true, labelId = 0, page = 1 } = {}) {
	const request = transport?.request ?? defaultRequest;
	try {
		const friendsResponse = await request(FRIEND_LIST_PATH, {}, {
			method: "POST",
			body: { labelId, page },
			form: true,
			referer: CHAT_REFERER,
		});
		const friendsData = checked(friendsResponse, "获取沟通列表");
		const friends = listFrom(friendsData, ["friendList", "result", "list", "items"]).slice(0, Math.min(Math.max(Number(count) || 20, 1), MAX_THREADS));
		if (friends.length === 0) return { ok: true, myUid: Number(myUid) || 0, threads: [], fetchedAt: new Date().toISOString() };

		const ids = friends.map((friend) => Number(friend.friendId ?? friend.gid ?? friend.id ?? 0)).filter((id) => id > 0);
		const batches = chunk(ids, FRIEND_BATCH);
		let resolvedUid = Number(myUid) || 0;
		// 第一批先打一次，顺手从响应里的 `uid`（永远是"我"）学到自己是谁，
		// 省掉一次额外的 getUserInfo。结果存下来，下面不再对它重复请求 ——
		// 同一个 friendIds 打两次在 Boss 眼里就是两次真实请求。
		const perBatch = new Map();
		let needFirstBatch = true;
		if (resolvedUid === 0 && batches.length > 0) {
			const probe = await request(LAST_MESSAGES_PATH, { friendIds: batches[0].join(",") }, { referer: CHAT_REFERER });
			const probeList = listFrom(checked(probe, "获取最近消息"), ["messages", "list", "result"]);
			perBatch.set(batches[0].join(","), probeList);
			needFirstBatch = false;
			resolvedUid = Number(probeList.find((item) => item.uid)?.uid ?? 0) || 0;
		}
		if (resolvedUid === 0) {
			try { resolvedUid = (await fetchMyUid({ transport })).uid; } catch { resolvedUid = 0; }
		}

		const lastMessages = [];
		for (let i = 0; i < batches.length; i++) {
			const key = batches[i].join(",");
			if (i === 0 && needFirstBatch === false) {
				lastMessages.push(...perBatch.get(key));
				continue;
			}
			const response = await request(LAST_MESSAGES_PATH, { friendIds: key }, { referer: CHAT_REFERER });
			lastMessages.push(...listFrom(checked(response, "获取最近消息"), ["messages", "list", "result"]));
		}

		const byPeer = new Map();
		for (const item of lastMessages) {
			const info = item.lastMsgInfo ?? item;
			const fromId = Number(info.fromId ?? 0);
			const toId = Number(info.toId ?? 0);
			const peer = resolvedUid !== 0 ? (fromId === resolvedUid ? toId : fromId) : fromId;
			if (peer) byPeer.set(peer, item);
		}
		const threads = friends.map((friend) => normalizeThread(friend, byPeer.get(Number(friend.friendId ?? friend.gid ?? friend.id ?? 0)) ?? null, resolvedUid));
		const result = { ok: true, myUid: resolvedUid, threads, fetchedAt: new Date().toISOString() };
		if (save) writeJson(join(DATA_DIR, "conversations.json"), result);
		return result;
	} catch (err) {
		return { ok: false, reason: err?.code ?? "browser", error: String(err?.message ?? err), threads: [] };
	}
}

/**
 * 步骤 ③：取某个会话的 Boss 上下文（`securityId` 在里面）。
 * `historyMsg` 不带 securityId 会直接失败，所以这一步不能省。
 */
export async function fetchBossData(friendId, { transport = null } = {}) {
	const request = transport?.request ?? defaultRequest;
	const response = await request(BOSS_DATA_PATH, { bossId: Number(friendId) }, { referer: CHAT_REFERER });
	const raw = checked(response, "获取 Boss 会话信息");
	return raw?.data ?? raw;
}

/**
 * 发消息要的两张票。它们**都不在 cookie 里**，得单独问：
 *   page_token  ← `GET /wapi/zpuser/wap/getUserInfo.json` 的 `zpData.token`
 *   wt2         ← `GET /wapi/zppassport/get/wt`           的 `zpData.wt2`
 *
 * 注意：cookie 里的 `wt2` 与这个 wt2 同源但用途不同 —— MQTT 的 password
 * 用的是**接口返回的这个**，username 用的是 `page_token|0`。
 * （zhipin-geek 的模块注释写成 "wt2_cookie|0"，与它的代码不一致；以代码为准。）
 */
export async function fetchWsAuth({ transport = null, myUid = 0 } = {}) {
	const request = transport?.request ?? defaultRequest;
	const userResponse = await request(USER_INFO_PATH, {}, { referer: "https://www.zhipin.com/" });
	const user = checked(userResponse, "获取我的账号信息");
	const token = user.token ?? "";
	if (token === "") throw Object.assign(new Error("getUserInfo.json 没有返回 token，无法建立发消息通道"), { code: "NO_PAGE_TOKEN" });
	const wtResponse = await request(WS_TOKEN_PATH, {}, { referer: CHAT_REFERER });
	const wt = checked(wtResponse, "获取发消息令牌");
	const wt2 = wt.wt2 ?? "";
	if (wt2 === "") throw Object.assign(new Error("/wapi/zppassport/get/wt 没有返回 wt2，无法建立发消息通道"), { code: "NO_WT2" });
	return {
		pageToken: token,
		wt2,
		myUid: Number(user.userId ?? user.uid ?? 0) || Number(myUid) || 0,
		encryptUid: user.encryptUserId ?? "",
		name: user.name ?? "",
	};
}

/** 发消息之前的闸门：间隔 + 去重。返回 `{ ok: false, reason }` 表示这次不该发。 */
export function checkReplyGuard(friendId, text, { now = Date.now(), store = null } = {}) {
	const log = store ?? (readJson(SEND_LOG(), { version: 1, items: [] }) ?? { version: 1, items: [] });
	const items = log.items ?? [];
	const last = items[0] ?? null;
	if (last !== null) {
		const since = now - Date.parse(last.at);
		if (Number.isFinite(since) && since >= 0 && since < MIN_REPLY_INTERVAL_MS) {
			return { ok: false, reason: "too-fast", error: `距上一条消息只有 ${(since / 1000).toFixed(1)} 秒；最少间隔 ${MIN_REPLY_INTERVAL_MS / 1000} 秒（风控按频率扣分）` };
		}
		const same = items.find((item) => Number(item.friendId) === Number(friendId) && item.text === text && now - Date.parse(item.at) < DUPLICATE_WINDOW_MS);
		if (same !== undefined) return { ok: false, reason: "duplicate", error: "这条内容刚刚已经发过了，跳过重复发送" };
	}
	return { ok: true };
}

/** 发成功之后才落盘 —— 失败的尝试不占冷却窗口。 */
export function recordSentMessage(entry) {
	const path = SEND_LOG();
	const log = readJson(path, { version: 1, items: [] }) ?? { version: 1, items: [] };
	const items = [{ at: new Date().toISOString(), ...entry }, ...(log.items ?? [])].slice(0, 500);
	writeJson(path, { version: 1, updatedAt: items[0]?.at ?? null, items });
	return items[0];
}

/**
 * 给某个会话发一条消息 —— 走 MQTT（见 `boss/mqtt-chat.mjs`）。
 *
 * 求职端**没有**发消息的 HTTP 接口，所以这不是"换个 endpoint"能解决的：
 * 必须拿到 page_token + wt2 + 全部 cookie，再手写 MQTT CONNECT/PUBLISH 和
 * Protobuf 载荷。整条链路里只有这一步是写操作，所以：
 *   - 每次调用只发一条，不重试（MQTT 重发等于对 Boss 连发两条）；
 *   - 发送前过 `checkReplyGuard`（最小间隔 + 同内容去重）；
 *   - 发送成功才写 `sent-messages.json`；
 *   - 调用方（宿主路由 / UI）必须已经拿到用户明确确认。
 *
 * @param {number} friendId
 * @param {string} text
 * @param {{ replyTransport?: object, sender?: Function, now?: number, guardStore?: object }} [options]
 */
export async function sendReply(friendId, text, { replyTransport = null, sender = null, now = Date.now(), guardStore = null } = {}) {
	const id = Number(friendId);
	const body = String(text ?? "").trim();
	if (!Number.isFinite(id) || id <= 0) return { ok: false, reason: "bad-friend-id", error: "friendId 无效" };
	if (body === "") return { ok: false, reason: "empty-text", error: "消息内容不能为空" };
	if (body.length > 2000) return { ok: false, reason: "too-long", error: `消息过长（${body.length} 字），请精简到 2000 字以内` };

	const guard = checkReplyGuard(id, body, { now, store: guardStore });
	if (!guard.ok) return guard;

	// 一整条发送链共用**一个**传输：注入的（测试）优先，否则用现有 Chrome 页面。
	// 不再让每一步各自 connectExistingBossBrowser()，避免多处连接状态。
	let transport;
	let cookies = replyTransport?.cookies ?? null;
	if (replyTransport?.request !== undefined) {
		transport = replyTransport;
	} else {
		let connected;
		try {
			connected = await connectExistingBossBrowser();
			if (!connected.loggedIn) return { ok: false, reason: "logged-out", error: "现有 Chrome 的 Boss 登录态已失效" };
			if (connected.page === null) return { ok: false, reason: "no-page", error: "Chrome 里没有打开 Boss 页面；发消息需要带页面 Cookie" };
			transport = { request: (path, params, options) => browserJson(connected.page, path, params, options) };
			cookies = await connected.context.cookies(SITE_ORIGIN);
		} catch (err) {
			return { ok: false, reason: err?.code ?? "browser", error: String(err?.message ?? err) };
		}
	}

	try {
		const auth = await fetchWsAuth({ transport });
		if (!auth.myUid) return { ok: false, reason: "no-my-uid", error: "拿不到自己的 userId，无法组装消息接收方" };
		const bossData = await fetchBossData(id, { transport });
		// 先证明这个会话真的存在（getBossData 给了 securityId），再往它发东西。
		// 没有 securityId 说明会话对不上，硬发就是"发错人"。
		if (!bossData.securityId) return { ok: false, reason: "no-security-id", error: "该会话没有 securityId，无法确认发送目标；请先在 Boss 里打开这个会话" };
		const toEncryptUid = bossData.encryptBossId ?? bossData.encryptFriendId ?? "";
		const doSend = sender ?? sendChatMessage;
		const sent = await doSend({
			pageToken: auth.pageToken,
			wt2: auth.wt2,
			cookies: cookies ?? [],
			fromUid: auth.myUid,
			fromEncryptUid: auth.encryptUid,
			toUid: id,
			toEncryptUid,
			text: body,
		});
		// ⚠️ 记流水发生在**消息已经发出去之后**，所以它失败绝不能把结果翻成失败 ——
		// 那会让人以为没发出去，然后重发，等于对 Boss 连发两条。
		let logged = true;
		try {
			recordSentMessage({ friendId: id, text: body, server: sent?.server ?? null, bytes: sent?.bytes ?? null });
		} catch (err) {
			logged = false;
			// 日志写不进去（磁盘权限等）只在结果里标一下，不改 ok。
			// eslint-disable-next-line no-console
			console.warn?.(`[boss] 发送成功但流水记录失败：${String(err?.message ?? err)}`);
		}
		return { ok: true, friendId: id, text: body, via: "mqtt", server: sent?.server ?? null, sentAt: new Date().toISOString(), logged };
	} catch (err) {
		if (err instanceof ChatSendError || err?.name === "ChatSendError") return { ok: false, reason: err.code ?? "send-failed", error: err.message };
		if (["ip-risk", "account-risk", "environment-risk", "browser-blocked", "rate-limited"].includes(err?.code)) return { ok: false, reason: err.code, error: String(err?.message ?? err) };
		return { ok: false, reason: err?.code ?? "send-failed", error: String(err?.message ?? err) };
	}
}

/**
 * 步骤 ④：一页历史消息。要更多就自己带 `maxMsgId` 翻页。
 * @returns {{ messages: object[], minMsgId: number, hasMore: boolean }}
 */
export async function fetchHistoryPage(friendId, { securityId, count = HISTORY_PAGE_SIZE, maxMsgId = 0, myUid = 0, transport = null } = {}) {
	const request = transport?.request ?? defaultRequest;
	const params = {
		gid: Number(friendId),
		c: Math.min(Math.max(Number(count) || HISTORY_PAGE_SIZE, 1), HISTORY_PAGE_SIZE),
		src: 0,
		securityId,
	};
	if (maxMsgId) params.maxMsgId = maxMsgId;
	const response = await request(HISTORY_PATH, params, { referer: CHAT_REFERER });
	const data = checked(response, "获取聊天记录");
	const raw = listFrom(data, ["messages", "msgList", "list"]);
	const messages = normalizeChatMessages(raw, { myUid });
	return {
		messages,
		minMsgId: Number(data?.minMsgId ?? 0) || 0,
		hasMore: data?.hasMore === true,
		rawCount: raw.length,
	};
}

/**
 * 步骤 ③④：读取指定会话的历史。默认只读 1 页（≤20 条）；
 * `count > 20` 时按 `maxMsgId` 最多翻 `MAX_HISTORY_PAGES` 页，然后停。
 */
export async function fetchConversation(friendId, { count = HISTORY_PAGE_SIZE, myUid = 0, transport = null, save = true, maxPages = MAX_HISTORY_PAGES } = {}) {
	try {
		const bossData = await fetchBossData(friendId, { transport });
		const securityId = bossData.securityId ?? "";
		if (!securityId) throw Object.assign(new Error("该会话没有 securityId，无法读取历史消息"), { code: "no-security-id" });

		const wanted = Math.min(Math.max(Number(count) || HISTORY_PAGE_SIZE, 1), HISTORY_PAGE_SIZE * Math.max(Number(maxPages) || 1, 1));
		const pages = Math.min(Math.ceil(wanted / HISTORY_PAGE_SIZE), Math.max(Number(maxPages) || 1, 1));
		const collected = [];
		let maxMsgId = 0;
		let last = null;
		for (let i = 0; i < pages; i++) {
			last = await fetchHistoryPage(friendId, { securityId, count: Math.min(HISTORY_PAGE_SIZE, wanted - collected.length), maxMsgId, myUid, transport });
			if (last.messages.length === 0) break;
			collected.push(...last.messages);
			if (collected.length >= wanted || !last.hasMore) break;
			// 翻页游标：优先接口给的 minMsgId（本页最老一条），没有就退回本页最老消息的 mid。
			const next = last.minMsgId || Number(last.messages[0]?.id ?? 0) || 0;
			if (!next || next === maxMsgId) break;
			maxMsgId = next;
		}
		// 翻页是按"从新到老"取的，最后统一按时间去重、正序。
		const seen = new Set();
		const messages = collected
			.filter((message) => (seen.has(message.id) ? false : (seen.add(message.id), true)))
			.sort((a, b) => String(a.at ?? a.id).localeCompare(String(b.at ?? b.id)))
			.slice(-wanted);
		const result = { ok: true, friendId: Number(friendId), boss: bossData, messages, summary: summarizeConversation(messages), fetchedAt: new Date().toISOString() };
		if (save) writeJson(join(DATA_DIR, `conversation-${Number(friendId)}.json`), result);
		return result;
	} catch (err) {
		return { ok: false, reason: err?.code ?? "browser", error: String(err?.message ?? err), friendId: Number(friendId), messages: [] };
	}
}

/** 岗位 ↔ 会话的匹配：先认 encryptJobId（唯一），再退回"职位名 + 公司"。 */
export function findThreadForJob(threads, job) {
	const exact = (threads ?? []).find((thread) => thread.encryptJobId && [job?.id, job?.encryptJobId].includes(thread.encryptJobId));
	if (exact) return exact;
	return (threads ?? []).find((thread) => thread.jobName === job?.title && (!thread.company || !job?.company || thread.company === job.company)) ?? null;
}
