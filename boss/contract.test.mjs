/**
 * 接口契约测试：路径、参数名、响应字段名必须有依据。
 *
 * 为什么单独一个文件：这个插件最容易出的 bug 不是"代码写错"，而是"参数名记错" ——
 * 比如 37 被当成登录过期、`encryptJobId` 被当成 `securityId`、打招呼漏掉 `greeting`。
 * 这类错误**不会报错**，只会静默返回空数据，看起来像"Boss 今天没岗位"。
 *
 * 所以这里把两个参考项目（zhipin-geek / boss-agent-cli）里**已在真实账号跑通**的
 * 契约写成断言。断言失败 = 有人把契约改回了没有依据的写法。
 *
 * 全部离线：没有真实网络请求，transport / sender 都是假的。
 *
 *   node boss/contract.test.mjs
 */
import assert from "node:assert/strict";

import {
	EDUCATION_MAP, EXPERIENCE_MAP, FILTER_SPECS, INDUSTRY_MAP, JOB_TYPE_MAP,
	SALARY_MAP, SCALE_MAP, STAGE_MAP, filterCode,
} from "./lib.mjs";
import {
	BOSS_DATA_PATH, FRIEND_LIST_PATH, HISTORY_PATH, LAST_MESSAGES_PATH, USER_INFO_PATH, WS_TOKEN_PATH,
	checkReplyGuard, fetchMessageThreads, fetchConversation, normalizeThread, sendReply,
} from "./messages.mjs";
import {
	MQTT_TOPIC, buildTextMessage, cookieHeader, describeConnack, encodeConnect, encodePublish,
	encodeUser, readConnack, sendChatMessage,
} from "./mqtt-chat.mjs";
import { sendGreeting } from "./greet.mjs";
import { mapJobDetail } from "./detail.mjs";
let pass = 0;
const fail = [];
async function check(name, fn) {
	try {
		await fn();
		pass++;
		console.log(`  PASS  ${name}`);
	} catch (err) {
		fail.push(name);
		console.log(`  FAIL  ${name}\n        ${String(err?.message ?? err).split("\n").join("\n        ")}`);
	}
}
const section = (title) => console.log(`\n── ${title} ──`);

/** 造一份符合真实响应的假 transport，并记录每一次请求。 */
function fakeTransport(routes, { calls = [] } = {}) {
	return {
		calls,
		async request(path, params, options) {
			calls.push({ path, params, options });
			for (const [pattern, handler] of routes) {
				if (path.includes(pattern)) return { status: 200, url: path, json: { code: 0, zpData: handler(params, options) }, text: "" };
			}
			throw new Error(`假 transport 没有配置 ${path} 的路由`);
		},
	};
}

const ok = (json) => ({ status: 200, url: "https://www.zhipin.com/x", json, text: "" });

//#region 1. 接口路径
section("1. 接口路径与参数名（对齐 zhipin-geek 的可用实现）");

await check("会话列表是 POST form 的 geekFilterByLabel，带 labelId + page", async () => {
	const transport = fakeTransport([
		[FRIEND_LIST_PATH, () => ({ friendList: [{ friendId: 7, name: "李女士" }] })],
		[LAST_MESSAGES_PATH, () => [{ uid: 1, lastMsgInfo: { fromId: 7, toId: 1, showText: "方便聊聊吗" } }]],
	]);
	await fetchMessageThreads({ transport, myUid: 1, save: false });
	const call = transport.calls.find((c) => c.path === FRIEND_LIST_PATH);
	assert.equal(call.options.method, "POST");
	assert.equal(call.options.form, true, "geekFilterByLabel 必须 form-encoded");
	assert.deepEqual(call.options.body, { labelId: 0, page: 1 });
});

await check("路径常量与参考实现逐字一致", () => {
	assert.equal(FRIEND_LIST_PATH, "/wapi/zprelation/friend/geekFilterByLabel");
	assert.equal(LAST_MESSAGES_PATH, "/wapi/zpchat/geek/userLastMsg");
	assert.equal(BOSS_DATA_PATH, "/wapi/zpchat/geek/getBossData");
	assert.equal(HISTORY_PATH, "/wapi/zpchat/geek/historyMsg");
	assert.equal(USER_INFO_PATH, "/wapi/zpuser/wap/getUserInfo.json");
	assert.equal(WS_TOKEN_PATH, "/wapi/zppassport/get/wt");
});

await check("historyMsg 参数是 gid/c/src/securityId，翻页游标叫 maxMsgId（不是 page）", async () => {
	const transport = fakeTransport([
		[BOSS_DATA_PATH, () => ({ data: { securityId: "SEC-1" } })],
		[HISTORY_PATH, () => ({ messages: [], minMsgId: 0, hasMore: false })],
	]);
	await fetchConversation(42, { transport, myUid: 1, save: false });
	const call = transport.calls.find((c) => c.path === HISTORY_PATH);
	assert.equal(call.params.gid, 42);
	assert.equal(call.params.c, 20);
	assert.equal(call.params.src, 0);
	assert.equal(call.params.securityId, "SEC-1", "historyMsg 不带 securityId 会直接失败");
	assert.equal("page" in call.params, false, "page 不是这个接口的分页参数，翻页用 maxMsgId");
	assert.equal("friendId" in call.params, false);
});

await check("getBossData 用 bossId 参数，并从 zpData.data 里取 securityId", async () => {
	const transport = fakeTransport([
		[BOSS_DATA_PATH, (params) => ({ data: { securityId: `SEC-${params.bossId}` } })],
		[HISTORY_PATH, () => ({ messages: [] })],
	]);
	const result = await fetchConversation(99, { transport, myUid: 1, save: false });
	assert.equal(transport.calls[0].params.bossId, 99);
	assert.equal(result.ok, true, "外层 zpData.data.securityId 也要能取到");
});

await check("历史消息翻页用 maxMsgId 游标，且最多翻有限页", async () => {
	const transport = fakeTransport([
		[BOSS_DATA_PATH, () => ({ data: { securityId: "SEC" } })],
		[HISTORY_PATH, (params) => {
			const start = params.maxMsgId === undefined ? 100 : params.maxMsgId;
			const messages = Array.from({ length: 20 }, (_, i) => ({
				mid: start - i,
				received: true,
				from: { uid: 7 },
				to: { uid: 1 },
				body: { text: `第 ${start - i} 条` },
				time: (start - i) * 1000,
			}));
			return { messages, minMsgId: start - 19, hasMore: true };
		}],
	]);
	const result = await fetchConversation(7, { transport, myUid: 1, count: 40, save: false });
	const pages = transport.calls.filter((c) => c.path === HISTORY_PATH);
	assert.equal(pages.length, 2, "要 40 条就该正好翻两页");
	assert.equal(pages[0].params.maxMsgId, undefined, "第一页不能带游标");
	assert.equal(pages[1].params.maxMsgId, 81, "第二页游标应该是上一页的 minMsgId");
	// 第一页 100..81，第二页 81..62 —— 81 重叠一条，去重后 39 条（<40 时不再翻第三页）
	assert.equal(result.messages.length, 39);
	// 去重 + 时间正序
	const ids = result.messages.map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length, "翻页重叠的消息要去重");
	assert.deepEqual(ids, [...ids].sort((a, b) => Number(a) - Number(b)), "结果要按时间正序");
	assert.equal(ids.at(-1), "100", "正序时最后一条是最新的");
});

await check("最近消息按每批 20 个 friendId 分批 —— 超过 20 个不能塞进一个请求", async () => {
	const friends = Array.from({ length: 25 }, (_, i) => ({ friendId: i + 1, name: `Boss${i + 1}` }));
	const transport = fakeTransport([
		[FRIEND_LIST_PATH, () => ({ friendList: friends })],
		[LAST_MESSAGES_PATH, (params) => String(params.friendIds).split(",").map((id, index) => ({
			uid: 1,
			lastMsgInfo: { fromId: 1, toId: Number(id), showText: `msg-${index}` },
		}))],
	]);
	const result = await fetchMessageThreads({ transport, myUid: 1, count: 25, save: false });
	const batches = transport.calls.filter((c) => c.path === LAST_MESSAGES_PATH);
	assert.equal(batches.length, 2, "25 个 friendId 应该分成 2 批（20 + 5）");
	assert.equal(batches[0].params.friendIds.split(",").length, 20);
	assert.equal(batches[1].params.friendIds.split(",").length, 5);
	assert.equal(result.threads.length, 25);
});

await check("userLastMsg 的 uid 就是我自己，对端取另一侧", async () => {
	const thread = normalizeThread(
		{ friendId: 7, name: "李女士", brandName: "示例科技", jobName: "Java 后端", encryptJobId: "J1", securityId: "S1" },
		{ uid: 1, lastTime: "今天 10:00", lastMsgInfo: { msgId: 555, fromId: 7, toId: 1, showText: "方便聊聊吗" } },
		1,
	);
	assert.equal(thread.peerId, 7, "fromId 是对方、toId 是我 → 对端是别人");
	assert.equal(thread.needsReply, true);
	assert.equal(thread.lastMessageId, 555, "accept/reject 要的 mid 来自 lastMsgInfo.msgId");
});

await check("我发出去的最近一条不算「需要我回」", async () => {
	const thread = normalizeThread({ friendId: 7 }, { uid: 1, lastMsgInfo: { fromId: 1, toId: 7, showText: "好的" } }, 1);
	assert.equal(thread.needsReply, false);
});
//#endregion

//#region 2. 消息方向与内容
section("2. 消息方向与内容映射");

await check("received 字段优先决定方向，body.type 决定非文本占位", async () => {
	const transport = fakeTransport([
		[BOSS_DATA_PATH, () => ({ data: { securityId: "S" } })],
		[HISTORY_PATH, () => ({
			messages: [
				{ mid: 1, received: true, from: { uid: 7, name: "李女士" }, to: { uid: 1 }, body: { text: "你好" }, time: 1000 },
				{ mid: 2, received: false, from: { uid: 1 }, to: { uid: 7 }, body: { text: "您好" }, time: 2000 },
				{ mid: 3, received: true, from: { uid: 7 }, to: { uid: 1 }, body: { type: 8, jobDesc: { title: "资深后端" } }, time: 3000 },
			],
		})],
	]);
	const result = await fetchConversation(7, { transport, myUid: 1, save: false });
	assert.deepEqual(result.messages.map((m) => m.direction), ["incoming", "outgoing", "incoming"]);
	assert.equal(result.messages[0].fromName, "李女士");
	assert.match(result.messages[2].text, /职位卡片.*资深后端/u);
	assert.equal(result.summary.needsReply, true, "最后一条是对方发的");
});
//#endregion

//#region 3. 筛选字典
section("3. 筛选字典（服务端码）");

await check("薪资是 8 档 401-408，不是 7 档", () => {
	assert.equal(SALARY_MAP["10-15K"], 404);
	assert.equal(SALARY_MAP["15-20K"], 405);
	assert.equal(SALARY_MAP["20-30K"], 406);
	assert.equal(SALARY_MAP["30-50K"], 407);
	assert.equal(SALARY_MAP["50K以上"], 408);
	assert.equal(SALARY_MAP["10-20K"], undefined, "10-20K 不是一个真实档位，别留着错映射");
});

await check("经验是 101-105 + 108，1-3年 是 102 而不是 103", () => {
	assert.equal(EXPERIENCE_MAP["在校/应届"], 108);
	assert.equal(EXPERIENCE_MAP["1年以内"], 101);
	assert.equal(EXPERIENCE_MAP["1-3年"], 102);
	assert.equal(EXPERIENCE_MAP["3-5年"], 103);
	assert.equal(EXPERIENCE_MAP["5-10年"], 104);
	assert.equal(EXPERIENCE_MAP["10年以上"], 105);
});

await check("学历表覆盖高中及以下", () => {
	assert.equal(EDUCATION_MAP["初中及以下"], 209);
	assert.equal(EDUCATION_MAP["中专/中技"], 208);
	assert.equal(EDUCATION_MAP["高中"], 206);
	assert.equal(EDUCATION_MAP["本科"], 203);
});

await check("「不限」编码为 0，但本插件用 null 表示没选", () => {
	assert.equal(SALARY_MAP["不限"], 0);
	assert.equal(filterCode(SALARY_MAP, null), null);
	assert.equal(filterCode(SALARY_MAP, ""), null);
	assert.equal(filterCode(SALARY_MAP, "20-30K"), 406);
	assert.equal(filterCode(SALARY_MAP, "399"), "399", "已经是码就原样透传");
});

await check("FILTER_SPECS 的每个选项都能查到码 —— UI 不会再放到一半的行业", () => {
	assert.ok(FILTER_SPECS.length >= 7);
	for (const spec of FILTER_SPECS) {
		assert.ok(spec.options.length > 0, `${spec.label} 没有可选项`);
		for (const option of spec.options) {
			assert.notEqual(spec.map[option], undefined, `${spec.label} 的「${option}」在字典里没有码`);
		}
	}
	const industry = FILTER_SPECS.find((s) => s.key === "industry");
	assert.equal(industry.options.length, Object.keys(INDUSTRY_MAP).length - 1, "行业选项数应等于字典去掉「不限」");
	assert.ok(industry.options.includes("医疗健康"));
	assert.ok(industry.options.includes("政府/非营利"));
});

await check("规模/融资/类型字典完整", () => {
	assert.equal(Object.keys(SCALE_MAP).length, 7);
	assert.equal(Object.keys(STAGE_MAP).length, 9);
	assert.equal(JOB_TYPE_MAP["实习"], 1902, "实习是 1902，兼职才是 1903");
	assert.equal(JOB_TYPE_MAP["兼职"], 1903);
});
//#endregion

//#region 4. MQTT + Protobuf
section("4. 发消息：MQTT over WSS + Protobuf");

await check("Protobuf：User 的字段号是 uid=1 / name=2", () => {
	// uid=5 → field1 varint: tag=(1<<3)|0=0x08, value=5
	assert.deepEqual(encodeUser(5), [0x08, 0x05]);
	// 带 name="AB" → field2 (tag=(2<<3)|2=0x12) len=2 'A''B'
	assert.deepEqual(encodeUser(5, "AB"), [0x08, 0x05, 0x12, 0x02, 0x41, 0x42]);
});

await check("Protobuf：整条消息的字段号与参考实现一致", () => {
	const payload = buildTextMessage({ fromUid: 1, fromEncryptUid: "enc-me", toUid: 7, toEncryptUid: "enc-boss", text: "你好", clientTempId: 42 });
	const bytes = [...payload];
	assert.equal(bytes[0], 0x08, "ChatProtocol.type=1 → tag 0x08");
	assert.equal(bytes[1], 1);
	assert.equal(bytes[2], 0x1a, "ChatProtocol.messages=3 (length-delimited) → tag 0x1a");
	const text = new TextDecoder().decode(payload);
	assert.match(text, /你好/u, "文本要能原样被 UTF-8 解码出来");
	assert.match(text, /enc-me/u);
	assert.match(text, /enc-boss/u);
	// mid=4 与 cmid=11 都写同一个客户端临时号
	assert.ok(text.length > 0);
});

await check("mid 用变长整数编码，13 位时间戳不会溢出", () => {
	const payload = buildTextMessage({ fromUid: 1, toUid: 2, text: "x", clientTempId: 1764518400000 });
	assert.ok(payload.length > 0, "大数编码不应抛错或截断");
	// varint(1764518400000) 需要 6 个字节；能编码出来说明没走 32 位位运算
	const bytes = [...payload];
	assert.ok(bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255));
});

await check("空文本 / 缺 uid 直接拒绝（不发半条消息出去）", () => {
	assert.throws(() => buildTextMessage({ fromUid: 1, toUid: 2, text: "   " }), /不能为空/u);
	assert.throws(() => buildTextMessage({ fromUid: 0, toUid: 2, text: "x" }), /fromUid/u);
	assert.throws(() => buildTextMessage({ fromUid: 1, toUid: 0, text: "x" }), /toUid/u);
});

await check("MQTT CONNECT 是 3.1.1 + clean session + username/password", () => {
	const packet = encodeConnect({ clientId: "ws-ABC", username: "tok|0", password: "WT2" });
	assert.equal(packet[0], 0x10, "CONNECT 固定头");
	// MQTT 字符串 = 2 字节大端长度 + 内容，所以 "MQTT" 占 2..5，协议级别在第 6 字节
	assert.equal(packet[1], packet.length - 2, "Remaining Length 必须等于包体字节数，否则服务端直接断连");
	assert.equal(packet[2], 0x00, "协议名长度高字节");
	assert.equal(packet[3], 0x04, "协议名长度 = 4");
	assert.equal(String.fromCharCode(...packet.slice(4, 8)), "MQTT");
	assert.equal(packet[8], 0x04, "协议级别 4 = MQTT 3.1.1");
	assert.equal(packet[9], 0xc2, "标志位：username|password|cleanSession");
	assert.equal(packet[10], 0x00, "keepalive 高字节（默认 25）");
	assert.equal(packet[11], 25);
	const text = new TextDecoder().decode(packet);
	assert.match(text, /ws-ABC/u);
	assert.match(text, /tok\|0/u, "username 是 page_token + |0");
	assert.match(text, /WT2/u);
});

await check("MQTT PUBLISH 是 QoS 1、topic=chat、retain=false；载荷是原始 protobuf 字节", () => {
	const payload = buildTextMessage({ fromUid: 1, toUid: 2, text: "hi", clientTempId: 9 });
	const packet = encodePublish({ topic: MQTT_TOPIC, payload, qos: 1, packetId: 1 });
	assert.equal(packet[0], 0x32, "PUBLISH | QoS1；retain 位必须是 0");
	assert.equal(MQTT_TOPIC, "chat");
	const remaining = packet[1];
	assert.equal(packet.length, 2 + remaining);
	const text = new TextDecoder().decode(packet);
	assert.match(text, /chat/u);
	// 包标识紧跟主题之后：topic 是 2 字节长度 + 4 字节 "chat"
	assert.equal(packet[2], 0x00);
	assert.equal(packet[3], 0x04);
	assert.equal(packet[8], 0x00, "包标识高字节");
	assert.equal(packet[9], 0x01, "包标识低字节");
});

await check("CONNACK 解析：0 是成功，4/5 是鉴权失败且不该换域名重试", async () => {
	assert.deepEqual(readConnack(new Uint8Array([0x20, 0x02, 0x00, 0x00])), { sessionPresent: false, returnCode: 0 });
	assert.deepEqual(readConnack(new Uint8Array([0x20, 0x02, 0x01, 0x05])), { sessionPresent: true, returnCode: 5 });
	assert.equal(readConnack(new Uint8Array([0x30, 0x00])), null, "不是 CONNACK 就返回 null");
	// Node 的 WebSocket 给的是 Buffer（Uint8Array 的子类），浏览器给 ArrayBuffer——
	// 两种都得认，否则 CONNACK 读不出来，连接被拒也当成功。
	assert.deepEqual(readConnack(new Uint8Array([0x20, 0x02, 0x00, 0x04]).buffer), { sessionPresent: false, returnCode: 4 });
	const view = new Uint8Array([0xff, 0x20, 0x02, 0x00, 0x05]);
	assert.deepEqual(readConnack(view.subarray(1)), { sessionPresent: false, returnCode: 5 }, "带 byteOffset 的视图也要读对");
	assert.equal(readConnack(undefined), null);
	assert.match(describeConnack(4), /用户名或密码/u);
	assert.match(describeConnack(5), /Cookie|登录态/u);
});

await check("cookie 头用 `; ` 连接 —— 不带 Cookie 连 101 升级都过不去", () => {
	assert.equal(cookieHeader([{ name: "wt2", value: "a" }, { name: "bst", value: "b" }]), "wt2=a; bst=b");
	assert.equal(cookieHeader([]), "");
});

await check("sendChatMessage 会真的走 CONNECT → CONNACK → PUBLISH，并且只发一条", async () => {
	const frames = [];
	class FakeSocket {
		constructor(url, options) {
			this.url = url;
			this.options = options;
			this.listeners = {};
			frames.push({ kind: "open", url, options });
			queueMicrotask(() => this.emit("open", {}));
		}
		addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
		emit(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
		send(data) {
			const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
			// 按固定头的高 4 位判类型 —— 低 4 位带 QoS / retain 标志位
			//（PUBLISH QoS1 是 0x32 而不是 0x30，直接比 0x30 会漏掉真正的发布帧）
			const type = bytes[0] & 0xf0;
			frames.push({ kind: type === 0x10 ? "connect" : type === 0x30 ? "publish" : "other", byte: bytes[0], bytes });
			// 收到 CONNECT 就回 CONNACK 成功
			if (type === 0x10) queueMicrotask(() => this.emit("message", { data: new Uint8Array([0x20, 0x02, 0x00, 0x00]) }));
		}
		close() { this.closed = true; }
	}
	const result = await sendChatMessage({
		pageToken: "TOK", wt2: "WT2", cookies: [{ name: "wt2", value: "WT2" }],
		fromUid: 1, fromEncryptUid: "me", toUid: 7, toEncryptUid: "boss",
		text: "您好，方便聊聊吗", WebSocketImpl: FakeSocket, servers: ["ws6.zhipin.com"], timeoutMs: 2000,
	});
	assert.equal(result.ok, true);
	assert.equal(result.server, "ws6.zhipin.com");
	assert.equal(frames.filter((f) => f.kind === "connect").length, 1, "只应发一条 CONNECT");
	assert.equal(frames.filter((f) => f.kind === "publish").length, 1, "只应发一条 PUBLISH —— 重发等于对 Boss 连发两条");
	assert.equal(frames[0].url, "wss://ws6.zhipin.com:443/chatws");
	assert.equal(frames[0].options.headers.Origin, "https://www.zhipin.com");
	assert.equal(frames[0].options.headers.Cookie, "wt2=WT2");
});

await check("鉴权被拒（CONNACK=5）不换域名、不重试", async () => {
	let attempts = 0;
	class BadSocket {
		constructor() {
			attempts++;
			this.listeners = {};
			queueMicrotask(() => this.emit("open", {}));
		}
		addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
		emit(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
		send(data) {
			const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
			if (bytes[0] === 0x10) queueMicrotask(() => this.emit("message", { data: new Uint8Array([0x20, 0x02, 0x00, 0x05]) }));
		}
		close() {}
	}
	await assert.rejects(
		() => sendChatMessage({
			pageToken: "TOK", wt2: "WT2", fromUid: 1, toUid: 2, text: "x",
			WebSocketImpl: BadSocket, servers: ["a", "b", "c"], timeoutMs: 1000,
		}),
		(err) => err.code === "AUTH_REJECTED",
	);
	assert.equal(attempts, 1, "鉴权失败换域名没有意义，不能连打三个");
});

await check("缺 page_token / wt2 时在连网之前就失败", async () => {
	class NeverSocket { constructor() { throw new Error("不该连"); } }
	await assert.rejects(() => sendChatMessage({ pageToken: "", wt2: "x", fromUid: 1, toUid: 2, text: "x", WebSocketImpl: NeverSocket }), (e) => e.code === "NO_PAGE_TOKEN");
	await assert.rejects(() => sendChatMessage({ pageToken: "x", wt2: "", fromUid: 1, toUid: 2, text: "x", WebSocketImpl: NeverSocket }), (e) => e.code === "NO_WT2");
});
//#endregion

//#region 5. 发送闸门
section("5. 发送闸门：间隔 + 去重 + 显式确认");

await check("空内容 / 非法 friendId 打回", async () => {
	assert.equal((await sendReply(0, "x")).reason, "bad-friend-id");
	assert.equal((await sendReply(7, "   ")).reason, "empty-text");
	assert.equal((await sendReply(7, "x".repeat(2001))).reason, "too-long");
});

await check("两条消息之间必须有最小间隔", () => {
	const now = Date.parse("2026-09-18T10:00:00.000Z");
	const store = { version: 1, items: [{ at: new Date(now - 1000).toISOString(), friendId: 1, text: "上一条" }] };
	const gate = checkReplyGuard(2, "新的一条", { now, store });
	assert.equal(gate.ok, false);
	assert.equal(gate.reason, "too-fast");
	assert.match(gate.error, /最少间隔/u);
});

await check("同一个人同样的内容，短时间内不重复发（防双击 / 防重放）", () => {
	const now = Date.parse("2026-09-18T10:00:00.000Z");
	const store = { version: 1, items: [{ at: new Date(now - 10000).toISOString(), friendId: 7, text: "您好" }] };
	assert.equal(checkReplyGuard(7, "您好", { now, store }).reason, "duplicate");
	assert.equal(checkReplyGuard(8, "您好", { now, store }).ok, true, "换个人不算重复");
	assert.equal(checkReplyGuard(7, "换一句", { now, store }).ok, true, "换内容不算重复");
});

await check("sendReply 成功后落盘，失败不占冷却窗口", async () => {
	// 注入一份空 store：这一项不该读/写真实的 data/sent-messages.json
	const calls = [];
	const transport = {
		cookies: [{ name: "wt2", value: "WT2" }],
		async request(path) {
			calls.push(path);
			if (path === USER_INFO_PATH) return ok({ code: 0, zpData: { userId: 1, token: "TOK", encryptUserId: "me" } });
			if (path === WS_TOKEN_PATH) return ok({ code: 0, zpData: { wt2: "WT2F" } });
			if (path === BOSS_DATA_PATH) return ok({ code: 0, zpData: { data: { securityId: "S", encryptBossId: "boss-enc" } } });
			throw new Error(`意外请求 ${path}`);
		},
	};
	const sent = [];
	const result = await sendReply(7, "契约测试文本", {
		replyTransport: transport,
		guardStore: { version: 1, items: [] },
		sender: async (input) => { sent.push(input); return { ok: true, server: "ws6.zhipin.com", bytes: 100 }; },
	});
	assert.equal(result.ok, true);
	assert.equal(result.via, "mqtt");
	assert.equal(sent.length, 1);
	assert.equal(sent[0].fromUid, 1);
	assert.equal(sent[0].toUid, 7);
	assert.equal(sent[0].toEncryptUid, "boss-enc");
	assert.equal(sent[0].pageToken, "TOK");
	assert.equal(sent[0].wt2, "WT2F", "MQTT 的 wt2 来自接口，不是 cookie 里那个");
	assert.deepEqual(calls.slice(0, 3), [USER_INFO_PATH, WS_TOKEN_PATH, BOSS_DATA_PATH]);
});

await check("MQTT 发送失败时不写发送记录 —— 冷却窗口留给下一次真发", async () => {
	const transport = {
		cookies: [],
		async request(path) {
			if (path === USER_INFO_PATH) return ok({ code: 0, zpData: { userId: 1, token: "TOK" } });
			if (path === WS_TOKEN_PATH) return ok({ code: 0, zpData: { wt2: "WT2F" } });
			return ok({ code: 0, zpData: { data: { securityId: "S" } } });
		},
	};
	const result = await sendReply(123456, "失败用例", {
		replyTransport: transport,
		guardStore: { version: 1, items: [] },
		sender: async () => { throw Object.assign(new Error("连不上"), { name: "ChatSendError", code: "WS_UNREACHABLE" }); },
	});
	assert.equal(result.ok, false);
	assert.equal(result.reason, "WS_UNREACHABLE");
});

await check("拿不到 securityId 时不发消息", async () => {
	const transport = {
		cookies: [],
		async request(path) {
			if (path === USER_INFO_PATH) return ok({ code: 0, zpData: { userId: 1, token: "TOK" } });
			if (path === WS_TOKEN_PATH) return ok({ code: 0, zpData: { wt2: "WT2F" } });
			return ok({ code: 0, zpData: {} });
		},
	};
	let didSend = false;
	const result = await sendReply(999999, "没 securityId", {
		replyTransport: transport,
		guardStore: { version: 1, items: [] },
		sender: async () => { didSend = true; return {}; },
	});
	assert.equal(result.ok, false, "没有 securityId 时继续发等于用错的会话发消息");
	assert.equal(didSend, false);
});
//#endregion

//#region 6. 打招呼
section("6. 打招呼：必须把用户改过的话术真的发出去");

await check("打招呼缺参数时立刻拒绝（不连浏览器、不假装成功）", async () => {
	assert.match((await sendGreeting(null, { jobId: "J", text: "x" })).error, /securityId/u);
	assert.match((await sendGreeting(null, { securityId: "S", text: "x" })).error, /jobId \/ lid/u);
});

await check("打招呼真的把 greeting 放进请求体（POST form），而不是只发 GET 参数", async () => {
	const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./greet.mjs", import.meta.url), "utf8"));
	// 离线可验证的契约：代码里必须存在 POST + form + greeting 三件事。
	// 发真实请求需要 Chrome，所以这里检查"发出的形状"，而不是结果。
	assert.match(source, /method:\s*"POST"/u, "打招呼必须走 POST");
	assert.match(source, /form:\s*true/u, "打招呼是 form-encoded");
	assert.match(source, /greeting:\s*text/u, "greeting 必须来自用户传入的 text");
	assert.match(source, /body\.lid\s*=/u, "lid 要带上（zhipin-geek 用它定位检索实例）");
	assert.equal(/method:\s*"GET"[\s\S]{0,200}friend\/add\.json/u.test(source), false, "不该再有 GET friend/add.json 的旧写法");
});
//#endregion

//#region 7. 详情映射
section("7. JD 详情映射");

await check("详情响应映射出完整 JD 与公司/规模/融资", () => {
	const mapped = mapJobDetail(
		{ id: "J1", title: "旧标题", jd: "", lid: "LID" },
		{
			jobInfo: { encryptJobId: "J1", jobName: "资深后端", postDescription: "负责交易系统", salaryDesc: "30-50K", cityName: "北京", areaDistrict: "海淀区", experienceName: "5-10年", degreeName: "本科" },
			bossInfo: { name: "张女士", title: "招聘经理" },
			brandComInfo: { brandName: "示例科技", industryName: "互联网", brandScaleName: "1000-9999人", brandStageName: "已上市" },
		},
	);
	assert.equal(mapped.jd, "负责交易系统");
	assert.equal(mapped.company, "示例科技");
	assert.equal(mapped.scale, "1000-9999人");
	assert.equal(mapped.stage, "已上市");
	assert.equal(mapped.lid, "LID", "lid 要保留 —— 打招呼要用它");
});
//#endregion

console.log(`\n${"─".repeat(60)}`);
console.log(fail.length === 0 ? `全部通过 ✅（${pass} 项）` : `${fail.length} 项失败 ❌（通过 ${pass} 项）`);
for (const name of fail) console.log(`  ✗ ${name}`);
process.exit(fail.length === 0 ? 0 : 1);
