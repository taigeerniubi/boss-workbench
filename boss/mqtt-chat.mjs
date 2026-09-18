/**
 * 给 Boss 发消息 —— MQTT over WSS。
 *
 * **为什么不能用 HTTP**：求职端没有"发消息"的 HTTP 接口。zhipin-geek 的
 * `boss_cli/mqtt_chat.py` 是唯一在真实账号上跑通的路径：
 *
 *   WS    `wss://ws6.zhipin.com:443/chatws`
 *   MQTT  client_id = "ws-" + 16 位随机大写 hex
 *         username  = <getUserInfo.json 的 zpData.token> + "|0"
 *         password  = <GET /wapi/zppassport/get/wt 的 zpData.wt2>
 *         TOPIC     = "chat"，QoS 1，retain = **false**
 *   WS 头  `Origin: https://www.zhipin.com` + `Cookie: <全部 cookie 用 "; " 连起来>`
 *         —— 不带 Cookie 连 101 升级都拿不到，直接 403。
 *   载荷  手写 Protobuf `TechwolfChatProtocol`（字段号见下）
 *
 * 这个文件只依赖 Node 20+ 自带的 `WebSocket`（Node 22+ 默认可用），
 * 不引入 mqtt.js / paho 之类运行时依赖 —— 装包本身就是要避免的运维负担。
 *
 * ⚠️ 两条与参考项目**有意为之**的差别：
 *   1. `WS_SERVERS` 里三个域名会**依次真试**（参考实现列了三个却只用第一个，
 *      第一个不通就永远不通）。仍然不做无限重试：每个域名只试一次。
 *   2. 参考实现发布的 `mid` / `cmid` 是 `Date.now()` 这个**客户端临时 id**。
 *      这里保留同一语义，但显式命名成 `clientTempId` 并写进注释，
 *      免得后人以为它是服务端消息号（服务端消息号在 `lastMsgInfo.msgId`）。
 *
 * 本模块**只发消息，不订阅**。收到对方的新消息靠重新拉一次
 * `userLastMsg`（`boss/messages.mjs`），因为参考实现的 MQTT 客户端也没有 subscribe。
 */

export const WS_SERVERS = ["ws6.zhipin.com", "ws.zhipin.com", "ws2.zhipin.com"];
export const WS_PORT = 443;
export const WS_PATH = "/chatws";
export const MQTT_TOPIC = "chat";
export const DEFAULT_TIMEOUT_MS = 12000;

//#region Protobuf（只实现这一份 schema 需要的部分）
// 线格式：0=varint，2=length-delimited。
const varint = (value) => {
	let v = Math.floor(Number(value));
	const out = [];
	// 用位运算会在大值上溢出（mid 是 13 位时间戳），所以走除法。
	do {
		const byte = v % 128;
		v = Math.floor(v / 128);
		out.push(v > 0 ? byte | 0x80 : byte);
	} while (v > 0);
	return out;
};
const lenPrefix = (bytes) => varint(bytes.length);
/** field = (fieldNumber << 3) | wireType，再跟 varint 或 length-delimited 数据。 */
function fieldVarint(fieldNumber, value) {
	return [...varint((fieldNumber << 3) | 0), ...varint(value)];
}
function fieldBytes(fieldNumber, bytes) {
	return [...varint((fieldNumber << 3) | 2), ...lenPrefix(bytes), ...bytes];
}
const utf8 = (text) => [...new TextEncoder().encode(String(text))];
const fieldString = (fieldNumber, text) => fieldBytes(fieldNumber, utf8(text));

/** TechwolfUser { uid=1, name=2, source=7 } —— 这里 `name` 装的是 encryptUserId / encryptFriendId。 */
export function encodeUser(uid, encryptUid = "", source = 0) {
	const bytes = [...fieldVarint(1, uid)];
	if (encryptUid) bytes.push(...fieldString(2, encryptUid));
	if (source) bytes.push(...fieldVarint(7, source));
	return bytes;
}

/** TechwolfMessageBody { type=1, templateId=2, text=3 }；type=1 文本，templateId=1。 */
export function encodeBody(text) {
	return [...fieldVarint(1, 1), ...fieldVarint(2, 1), ...fieldString(3, text)];
}

/** TechwolfMessage { from=1, to=2, type=3, mid=4, cmid=11, body=6 }。 */
export function encodeMessage({ fromUid, fromEncryptUid = "", toUid, toEncryptUid = "", text, clientTempId }) {
	return [
		...fieldBytes(1, encodeUser(fromUid, fromEncryptUid)),
		...fieldBytes(2, encodeUser(toUid, toEncryptUid)),
		...fieldVarint(3, 1),
		...fieldVarint(4, clientTempId),
		...fieldVarint(11, clientTempId),
		...fieldBytes(6, encodeBody(text)),
	];
}

/** TechwolfChatProtocol { type=1, messages=3 }。 */
export function encodeChatProtocol(messageBytes) {
	return [...fieldVarint(1, 1), ...fieldBytes(3, messageBytes)];
}

/**
 * 组装一条完整的文本消息载荷。
 * @param {object} input
 * @param {number} input.fromUid 我自己的 uid（getUserInfo.json → userId）
 * @param {number} input.toUid   对方的 friendId
 * @param {number} [input.clientTempId] 客户端临时消息号，默认取当前毫秒时间戳
 */
export function buildTextMessage({ fromUid, fromEncryptUid = "", toUid, toEncryptUid = "", text, clientTempId = Date.now() }) {
	if (!fromUid || !toUid) throw new Error("发消息需要 fromUid 与 toUid");
	if (typeof text !== "string" || text.trim() === "") throw new Error("消息内容不能为空");
	const message = encodeMessage({ fromUid, fromEncryptUid, toUid, toEncryptUid, text, clientTempId });
	return Uint8Array.from(encodeChatProtocol(message));
}
//#endregion

//#region MQTT 报文
const PACKET = { CONNECT: 0x10, CONNACK: 0x20, PUBLISH: 0x30, PINGREQ: 0xc0, DISCONNECT: 0xe0 };
/** MQTT 的 "Remaining Length" 是变长整数编码（每字节 7 位，最高位是延续位）。 */
const remainingLength = (n) => varint(n);
/** MQTT UTF-8 字符串：2 字节大端长度 + 内容。 */
const mqttString = (text) => {
	const bytes = utf8(text);
	return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
};

/**
 * 编码 CONNECT（MQTT 3.1.1，clean session，无 will，username+password）。
 * 标志位：username 0x80 | password 0x40 | cleanSession 0x02 = 0xC2。
 */
export function encodeConnect({ clientId, username, password, keepalive = 25 }) {
	const payload = [
		...mqttString(clientId),
		...mqttString(username),
		...mqttString(password),
	];
	const variableHeader = [...mqttString("MQTT"), 0x04, 0xc2, keepalive >> 8, keepalive & 0xff];
	return Uint8Array.from([PACKET.CONNECT, ...remainingLength(variableHeader.length + payload.length), ...variableHeader, ...payload]);
}

/** 编码 PUBLISH：固定头 (0x30|qos<<1) + 主题 + [包标识] + 载荷。QoS 0 不带包标识。 */
export function encodePublish({ topic = MQTT_TOPIC, payload, qos = 1, packetId = 1, retain = false }) {
	if (qos > 0 && (packetId < 1 || packetId > 0xffff)) throw new Error("QoS>0 需要一个 1..65535 的包标识");
	const body = [...mqttString(topic)];
	if (qos > 0) body.push(packetId >> 8, packetId & 0xff);
	body.push(...(payload instanceof Uint8Array ? payload : Uint8Array.from(payload)));
	const header = PACKET.PUBLISH | ((qos & 0x03) << 1) | (retain ? 0x01 : 0x00);
	return Uint8Array.from([header, ...remainingLength(body.length), ...body]);
}

export const encodePingReq = () => Uint8Array.from([PACKET.PINGREQ, 0x00]);
export const encodeDisconnect = () => Uint8Array.from([PACKET.DISCONNECT, 0x00]);

/**
 * 从 CONNACK 读出 return code（第 4 字节）。返回 null 表示"这不是 CONNACK"。
 *
 * 入参形状很杂，得全接住：浏览器的 `MessageEvent.data` 是 ArrayBuffer，
 * Node 的 WebSocket 给 Buffer/TypedArray，测试里给 Uint8Array。
 * 只认 `instanceof Uint8Array` 会在 Node 上漏掉 Blob，
 * 于是 CONNACK 永远读不出来 —— 消息看着"发出去了"，其实连接被拒了。
 */
export function readConnack(frame) {
	if (frame === null || frame === undefined) return null;
	let bytes;
	if (frame instanceof Uint8Array) bytes = frame;
	else if (typeof ArrayBuffer !== "undefined" && frame instanceof ArrayBuffer) bytes = new Uint8Array(frame);
	else if (ArrayBuffer.isView(frame)) bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
	else return null; // Blob 之类：本模块不订阅，也不需要处理
	if (bytes.length < 4 || (bytes[0] & 0xf0) !== PACKET.CONNACK) return null;
	return { sessionPresent: (bytes[2] & 0x01) === 1, returnCode: bytes[3] };
}

/** return code → 人话。0 以外都是失败。 */
export function describeConnack(code) {
	const table = {
		0: "连接成功",
		1: "协议版本不被支持",
		2: "clientId 被拒绝",
		3: "服务不可用",
		4: "用户名或密码错误（page_token / wt2 过期或不对）",
		5: "未授权（Cookie 没带上或登录态失效）",
	};
	return table[code] ?? `未知的 CONNACK 返回码 ${code}`;
}

/** curl 风格的 cookie 头：`k=v; k=v`。 */
export const cookieHeader = (cookies) => (cookies ?? []).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
//#endregion

/** 发消息过程中的可预期失败（网络/鉴权/超时），调用方按 code 分辨该怎么报给用户。 */
export class ChatSendError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "ChatSendError";
		this.code = code;
	}
}

/**
 * 只做一件事：连上 MQTT，publish 一条文本，断开。
 * 不订阅、不重试、不在进程里留连接 —— 每发一条消息就是一次独立短连接。
 *
 * @param {object} input
 * @param {string} input.pageToken `getUserInfo.json` 的 `zpData.token`
 * @param {string} input.wt2       `/wapi/zppassport/get/wt` 的 `zpData.wt2`
 * @param {object[]} input.cookies Playwright `context.cookies()` 的结果
 * @param {number} input.fromUid
 * @param {number} input.toUid
 * @param {string} input.text
 * @param {string[]} [input.servers]   覆盖默认的 WS 域名（测试用）
 * @param {number} [input.timeoutMs]
 * @param {Function} [input.WebSocketImpl] 注入 WebSocket 实现（测试用）
 */
export async function sendChatMessage({
	pageToken,
	wt2,
	cookies = [],
	fromUid,
	fromEncryptUid = "",
	toUid,
	toEncryptUid = "",
	text,
	servers = WS_SERVERS,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	WebSocketImpl = globalThis.WebSocket,
} = {}) {
	if (!pageToken) throw new ChatSendError("NO_PAGE_TOKEN", "拿不到 page_token（getUserInfo.json 的 zpData.token 为空），无法建立发消息通道");
	if (!wt2) throw new ChatSendError("NO_WT2", "拿不到 wt2（/wapi/zppassport/get/wt），无法建立发消息通道");
	if (typeof WebSocketImpl !== "function") throw new ChatSendError("NO_WEBSOCKET", "当前 Node 没有全局 WebSocket；需要 Node 22+ 或自行注入实现");
	const payload = buildTextMessage({ fromUid, fromEncryptUid, toUid, toEncryptUid, text });
	const wsCookies = cookieHeader(cookies);
	const clientId = `ws-${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`.toUpperCase();
	const failures = [];

	for (const server of servers) {
		const url = `wss://${server}:${WS_PORT}${WS_PATH}`;
		try {
			await publishOnce({ WebSocketImpl, url, wsCookies, clientId, pageToken, wt2, payload, timeoutMs });
			return { ok: true, server, topic: MQTT_TOPIC, bytes: payload.length, text };
		} catch (err) {
			failures.push(`${server} —— ${String(err?.message ?? err)}`);
			// 鉴权类失败换域名也没用，立刻收手（不制造更多连接）
			if (err?.code === "AUTH_REJECTED") throw err;
		}
	}
	throw new ChatSendError("WS_UNREACHABLE", `三个聊天服务器都连不上：\n  ${failures.join("\n  ")}`);
}

/** 连一个域名、发一条、断开。任何一步失败都抛，由上层决定要不要换域名。 */
function publishOnce({ WebSocketImpl, url, wsCookies, clientId, pageToken, wt2, payload, timeoutMs }) {
	return new Promise((resolve, reject) => {
		// Node 的 WebSocket 允许自定义头（浏览器里不允许，但我们不在浏览器里跑）。
		const socket = new WebSocketImpl(url, {
			headers: {
				Origin: "https://www.zhipin.com",
				Cookie: wsCookies,
			},
		});
		let settled = false;
		let pingTimer = null;
		const finish = (err, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (pingTimer !== null) clearInterval(pingTimer);
			try { socket.close(); } catch { /* 已经关了 */ }
			if (err) reject(err); else resolve(value);
		};
		const timer = setTimeout(() => finish(new ChatSendError("TIMEOUT", `连接或发送超时（${timeoutMs}ms）`)), timeoutMs);

		socket.addEventListener?.("open", () => {
			try {
				socket.send(encodeConnect({ clientId, username: `${pageToken}|0`, password: wt2 }));
			} catch (err) {
				finish(new ChatSendError("WS_SEND_FAILED", `CONNECT 发送失败：${String(err?.message ?? err)}`));
			}
		});
		socket.addEventListener?.("message", (event) => {
			const connack = readConnack(event?.data);
			if (connack === null) return; // 我们不订阅，所以只可能收到 CONNACK
			if (connack.returnCode !== 0) {
				finish(new ChatSendError(connack.returnCode === 4 || connack.returnCode === 5 ? "AUTH_REJECTED" : "CONNACK_FAILED", `MQTT 拒绝连接：${describeConnack(connack.returnCode)}`));
				return;
			}
			try {
				socket.send(encodePublish({ topic: MQTT_TOPIC, payload, qos: 1, packetId: 1 }));
			} catch (err) {
				finish(new ChatSendError("WS_SEND_FAILED", `PUBLISH 发送失败：${String(err?.message ?? err)}`));
				return;
			}
			// QoS 1 且没有订阅：PUBACK 可能不来。给一个很短的窗口收尾，避免把连接吊着。
			pingTimer = setInterval(() => { try { socket.send(encodePingReq()); } catch { /* 忽略 */ } }, 5000);
			setTimeout(() => {
				try { socket.send(encodeDisconnect()); } catch { /* 忽略 */ }
				finish(null, { sent: true });
			}, 300);
		});
		socket.addEventListener?.("error", (event) => {
			finish(new ChatSendError("WS_ERROR", `WebSocket 错误：${String(event?.message ?? event?.error?.message ?? "unknown")}`));
		});
		socket.addEventListener?.("close", (event) => {
			// 还没发出消息就断了 —— 当成失败；已经发完的正常关闭由 finish 兜住。
			finish(new ChatSendError("WS_CLOSED", `连接在发送完成前关闭（code=${event?.code ?? "?"}）`));
		});
	});
}
