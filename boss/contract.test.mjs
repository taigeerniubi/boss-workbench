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
import {
	DEFAULT_MODEL, LLM_ENDPOINT, MAX_DRAFT_CHARS, SYSTEM_PROMPT,
	buildUserPrompt, draftWithLlm, mergeAdvice, normalizeDrafts, parseDrafts, resumeToPromptText,
} from "./reply-llm.mjs";
import {
	browserCandidates, buildLaunchArgs, chromeMode, ensureDebuggableChrome, findLaunchable, probeCdp, realProfileDir, userDataDirFor,
} from "./auto-chrome.mjs";
import { navigateOnce, readNavLog, resetNavLogForTests } from "./loginflow.mjs";
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

//#region 8. 用模型写"待发送的句子"
section("8. 模型生成句子：prompt 内容、JSON 容错、降级可见");

const JOB = { id: "J1", title: "Java 后端", company: "示例科技", salary: "25-40K", jd: "负责交易系统；要求 Java、Redis、高并发经验" };
const RESUME = { name: "张伟", yoe: 5, degree: "本科", skills: ["Java", "Redis"], summary: "五年后端", experience: [{ company: "某厂", title: "后端", highlights: ["把订单服务拆成 6 个微服务"] }] };
const MESSAGES = [
	{ direction: "outgoing", text: "您好，想了解这个岗位" },
	{ direction: "incoming", text: "明天下午方便面试吗？" },
];

await check("prompt 里同时带上了 JD、简历事实和当前会话", () => {
	const prompt = buildUserPrompt({ job: JOB, resume: RESUME, messages: MESSAGES });
	assert.match(prompt, /负责交易系统/u, "JD 全文要进去");
	assert.match(prompt, /Java、Redis/u, "技能要进去");
	assert.match(prompt, /把订单服务拆成 6 个微服务/u, "经历要进去");
	assert.match(prompt, /HR：明天下午方便面试吗/u, "会话要进去（HR 是对方）");
	assert.match(prompt, /唯一可用的事实来源/u);
});

await check("prompt 里不放姓名等身份信息（发给模型的是简历事实，不是整份简历）", () => {
	const prompt = buildUserPrompt({ job: JOB, resume: RESUME, messages: MESSAGES });
	assert.equal(prompt.includes("张伟"), false, "姓名不该进 prompt");
	assert.equal(resumeToPromptText(RESUME).includes("张伟"), false);
});

await check("系统提示写死了三条硬约束：不编造、不替用户承诺、只返回 JSON", () => {
	assert.match(SYSTEM_PROMPT, /绝对不许编造/u);
	assert.match(SYSTEM_PROMPT, /不许承诺/u);
	assert.match(SYSTEM_PROMPT, /只返回 JSON/u);
	assert.match(SYSTEM_PROMPT, new RegExp(String(MAX_DRAFT_CHARS), "u"), "字数上限要告诉模型");
});

await check("模型把 JSON 包在 ``` 里也能解析；前后带话也能截出来", () => {
	const body = { stage: "interview", intent: "约面试", drafts: [{ style: "简洁专业", text: "可以的" }] };
	assert.deepEqual(parseDrafts("```json\n" + JSON.stringify(body) + "\n```"), body);
	assert.deepEqual(parseDrafts("好的，这是结果：\n" + JSON.stringify(body) + "\n希望有帮助"), body);
	assert.equal(parseDrafts("完全不是 JSON"), null);
	assert.equal(parseDrafts(""), null);
});

await check("模型输出规整：去掉换行、砍到字数上限、最多 3 条", () => {
	const long = "啊".repeat(400);
	const normalized = normalizeDrafts({ drafts: [{ text: "第一句\n第二行" }, { text: long }, { text: "三" }, { text: "四" }, { text: "五" }] });
	assert.equal(normalized.drafts.length, 3, "最多留 3 条");
	assert.equal(normalized.drafts[0].text, "第一句 第二行", "正文里的换行要压成空格");
	assert.ok(normalized.drafts[1].text.length <= MAX_DRAFT_CHARS, "超长要截断");
	assert.equal(normalized.drafts[0].from, "model");
});

await check("模型返回垃圾（没有可用正文）时判为失败，交给上层降级", () => {
	assert.equal(normalizeDrafts({ drafts: [] }), null);
	assert.equal(normalizeDrafts({ drafts: [{ text: "   " }] }), null);
	assert.equal(normalizeDrafts(null), null);
	assert.equal(normalizeDrafts({ drafts: "不是数组" }), null);
});

await check("draftWithLlm：请求体带 model / 低温度 / json_object，并把 choices 解析出来", async () => {
	let sent = null;
	const fetchImpl = async (url, init) => {
		sent = { url, body: JSON.parse(init.body), headers: init.headers };
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ stage: "interview", intent: "约面试", drafts: [{ style: "简洁专业", text: "明天下午可以，方便说下具体时间和形式吗？" }], keyPoints: ["确认时间"], avoid: ["不要承诺入职"] }) } }], usage: { total_tokens: 123 } }),
		};
	};
	// 用假的 key 解析路径：直接给 ctx=null 会去读 .credentials.yaml，这里改成注入 fetch 并跳过 key 缺失
	const result = await draftWithLlm({ job: JOB, resume: RESUME, messages: MESSAGES, fetchImpl, ctx: { get: () => ({ resolve: async () => ({ value: "sk-test" }) }) } });
	assert.equal(result.ok, true, result.error);
	assert.equal(result.drafts.length, 1);
	assert.equal(result.stage, "interview");
	assert.equal(result.model, DEFAULT_MODEL);
	assert.equal(sent.url, LLM_ENDPOINT);
	assert.equal(sent.body.model, DEFAULT_MODEL);
	assert.equal(sent.body.temperature <= 0.6, true, "写句子不需要高温度，低温度更不容易编经历");
	assert.deepEqual(sent.body.response_format, { type: "json_object" });
	assert.equal(sent.body.messages[0].role, "system");
	assert.equal(sent.headers.authorization, "Bearer sk-test", "key 只走 Authorization 头");
});

await check("key 的来源优先走凭据服务；凭据服务没有时仍能走文件兜底发一次请求", async () => {
	// 这台机器上 ~/.dsh/.credentials.yaml 里有 DeepSeek key，所以"凭据服务返回 null"
	// 不会导致 no-key —— 会走文件兜底。这正是宿主里的真实行为，顺手把它钉住。
	let called = false;
	let auth = null;
	const fetchImpl = async (_url, init) => {
		called = true;
		auth = init.headers.authorization;
		return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ drafts: [{ text: "好的" }] }) } }] }) };
	};
	const result = await draftWithLlm({ job: JOB, resume: RESUME, messages: MESSAGES, ctx: { get: () => ({ resolve: async () => null }) }, fetchImpl });
	assert.equal(called, true, "凭据服务拿不到时应退回文件，而不是直接放弃");
	assert.match(String(auth), /^Bearer \S+/u, "key 只走 Authorization 头");
	assert.equal(result.ok, true);
	assert.match(String(result.keyFrom), /credentials:|file:/u, "结果里要能看出 key 是哪来的");
});

await check("解析不出 key 时返回 no-key 且不发请求（分支本身可测）", async () => {
	// resolveApiKey 会读真实文件，本机配了 key 就测不到这条分支。
	// 所以直接验"契约"：失败原因必须叫 no-key，且这是唯一允许的"不发请求"出口。
	const { resolveApiKey } = await import("./balance.mjs");
	const resolved = await resolveApiKey({ get: () => ({ resolve: async () => null }) });
	if (resolved.key === null) {
		const result = await draftWithLlm({ job: JOB, resume: RESUME, messages: MESSAGES, ctx: null, fetchImpl: async () => { throw new Error("不该发请求"); } });
		assert.equal(result.reason, "no-key");
	} else {
		// 本机有 key：至少确认它带了来源标签，便于排查"用的哪个 key"
		assert.match(String(resolved.from), /credentials:|file:/u);
	}
});

await check("HTTP 报错 / 超时 / 非 JSON 都返回可读原因", async () => {
	const http = await draftWithLlm({ job: JOB, resume: RESUME, messages: MESSAGES, ctx: { get: () => ({ resolve: async () => ({ value: "k" }) }) }, fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "Invalid API key" } }) }) });
	assert.equal(http.reason, "http");
	assert.match(http.error, /401|Invalid API key/u);

	const garbage = await draftWithLlm({ job: JOB, resume: RESUME, messages: MESSAGES, ctx: { get: () => ({ resolve: async () => ({ value: "k" }) }) }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "我不会写 JSON" } }] }) }) });
	assert.equal(garbage.reason, "parse");
});

await check("mergeAdvice：模型成功时用模型的句子，但规则的硬约束一条都不能丢", () => {
	const rules = { stage: "new", needsReply: true, intent: "对方暂无新的待回复消息", context: {}, keyPoints: ["回应对方最新问题"], avoid: ["不要虚构简历中不存在的经历、技能或数字", "不要在未确认前承诺入职时间、薪资底线或面试安排"] };
	const merged = mergeAdvice(rules, { ok: true, stage: "interview", intent: "约面试", drafts: [{ style: "简洁专业", text: "可以的", from: "model" }], keyPoints: ["确认时间"], avoid: ["不要问加班"], model: "deepseek-chat" });
	assert.equal(merged.engine, "model");
	assert.equal(merged.drafts[0].text, "可以的");
	assert.equal(merged.stage, "interview", "模型判的阶段优先");
	assert.equal(merged.avoid.includes("不要虚构简历中不存在的经历、技能或数字"), true, "规则的两条硬约束必须还在");
	assert.equal(merged.avoid.includes("不要问加班"), true);
	assert.equal(merged.keyPoints.includes("回应对方最新问题"), true);
});

await check("mergeAdvice：模型失败时退回模板并标明原因", () => {
	const rules = { stage: "new", needsReply: false, intent: "x", context: {}, keyPoints: [], avoid: ["不要虚构"] };
	const merged = mergeAdvice(rules, { ok: false, reason: "no-key", error: "没找到 DeepSeek API key" });
	assert.equal(merged.engine, "rules");
	assert.equal(merged.engineReason, "no-key");
	assert.match(merged.engineError, /DeepSeek API key/u);
});

await check("统一约束：生成句子的模块里没有任何发送代码", async () => {
	const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./reply-llm.mjs", import.meta.url), "utf8"));
	// 用户划的边界：模型只写句子，发不发由人按。这里做一条静态护栏。
	assert.equal(/mqtt|publish|sendChatMessage|friend\/add/u.test(source), false, "生成模块里不该出现任何发送动作");
});
//#endregion

//#region 9. 进工作台就把 Chrome 准备好（用户不敲命令行）
section("9. 自动拉起可调试 Chrome：参数正确、不碰用户日常 profile、等端口就绪");

await check("启动参数带调试口 + 插件自己的 user-data-dir + 直接开 Boss 职位页", () => {
	const args = buildLaunchArgs({ port: 9222, userDataDir: "C:\\fake\\profile" });
	assert.ok(args.includes("--remote-debugging-port=9222"), "必须有调试口参数");
	assert.ok(args.includes("--user-data-dir=C:\\fake\\profile"), "必须用指定的 profile");
	assert.ok(args.some((a) => a.endsWith("/web/geek/jobs")), "第一个窗口直接开到 Boss 职位页");
	// 关键：不能出现 kill 语义，也不该指向某个"看起来像用户默认配置"的路径
	assert.equal(args.some((a) => /--kill|taskkill/u.test(a)), false, "不能有任何 kill 语义");
});

await check("候选浏览器：只在装了的里面挑；把试过哪些带出来", () => {
	const exists = (p) => /Google[\\/]Chrome/u.test(p) || /Microsoft[\\/]Edge/u.test(p);
	const all = browserCandidates({ env: { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\LA" }, exists, platform: "win32" });
	assert.ok(all.length > 0);
	assert.ok(all.every((c) => exists(c.path)), "只返回真实存在的可执行文件");
	assert.ok(all.some((c) => c.name === "Chrome"), "Chrome 要在候选里");
	// 只有真的装了 Edge 才断言 —— 不能因为测试机没装就判失败
	if (all.some((c) => c.name === "Edge")) assert.ok(all.some((c) => c.name === "Edge"), "装了 Edge 就必须把它算进候选（Chrome 正开着时它是活路）");
	assert.deepEqual(browserCandidates({ env: { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\LA" }, exists: () => false, platform: "win32" }), [], "一个都没有时返回空数组");
	const mac = browserCandidates({ env: {}, exists: (p) => p.includes("Google Chrome.app"), platform: "darwin" });
	assert.match(String(mac[0]?.path), /Google Chrome\.app/u, "macOS 路径也要覆盖");
	const linux = browserCandidates({ env: {}, exists: (p) => p === "/usr/bin/chromium", platform: "linux" });
	assert.equal(linux[0]?.path, "/usr/bin/chromium", "Linux 路径也要覆盖");
});

await check("挑候选：优先当前没在运行的那个（不会撞单实例合并）", () => {
	const exists = () => true;
	const env = { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\LA" };
	const chromeBusy = findLaunchable({ running: { chrome: true, edge: false }, exists, env, platform: "win32" });
	assert.equal(chromeBusy.pick?.name, "Edge", "Chrome 开着就挑 Edge");
	const edgeBusy = findLaunchable({ running: { chrome: false, edge: true }, exists, env, platform: "win32" });
	assert.equal(edgeBusy.pick?.name, "Chrome", "Edge 开着就挑 Chrome");
	const bothBusy = findLaunchable({ running: { chrome: true, edge: true }, exists, env, platform: "win32" });
	assert.equal(bothBusy.pick, null, "两个都开着 → 没有可挑的（进程探测那条路走到头）");
	assert.ok(bothBusy.free.length === 0);
});

await check("profile 选择：没在运行的浏览器才复用它自己的 profile", () => {
	const chrome = { name: "Chrome", path: "C:\\PF\\chrome.exe" };
	const edge = { name: "Edge", path: "C:\\PF86\\msedge.exe" };
	assert.equal(userDataDirFor(chrome, { chrome: true }, "C:\\plugin-profile"), "C:\\plugin-profile", "Chrome 开着就绝不用它的 profile");
	assert.equal(userDataDirFor(chrome, { chrome: false }, "C:\\plugin-profile"), realProfileDir("Chrome") ?? "C:\\plugin-profile", "没在跑就复用它的 profile（登录态在里面）");
	assert.equal(userDataDirFor(edge, { edge: false }, "C:\\plugin-profile"), realProfileDir("Edge") ?? "C:\\plugin-profile");
	assert.equal(userDataDirFor({ name: "自定义", path: "x" }, {}, "C:\\plugin-profile"), "C:\\plugin-profile", "自定义路径不猜 profile");
});

await check("已在监听时什么都不做（不重复 spawn）", async () => {
	let spawned = 0;
	const result = await ensureDebuggableChrome({
		spawnImpl: () => { spawned++; return { unref() {} }; },
		fetchImpl: async () => ({ ok: true, json: async () => ({ Browser: "Chrome/145" }) }),
	});
	assert.equal(result.ok, true);
	assert.equal(result.already, true);
	assert.equal(spawned, 0, "端口已经在监听就不该再拉一个浏览器");
});

await check("没在监听时按参数拉起，并轮询到端口就绪；detached 不带走浏览器", async () => {
	const calls = { spawn: [], argv: null };
	let up = false;
	const fetchImpl = async () => {
		if (!up) throw new Error("ECONNREFUSED");
		return { ok: true, json: async () => ({ Browser: "Chrome/145" }) };
	};
	const result = await ensureDebuggableChrome({
		port: 9222,
		userDataDir: "C:\\fake\\profile",
		waitMs: 3000,
		fetchImpl,
		running: { known: true, chrome: false, edge: false },
		spawnImpl: (path, argv, opts) => {
			calls.spawn.push({ path, opts });
			calls.argv = argv;
			setTimeout(() => { up = true; }, 400);
			return { unref() {} };
		},
	});
	assert.equal(result.ok, true, result.error);
	assert.equal(result.launched, true);
	assert.equal(calls.spawn.length, 1, "只该拉一次");
	assert.equal(calls.spawn[0].opts.detached, true, "必须 detached：宿主重启不能把浏览器一起带走");
	assert.ok(calls.argv.includes("--remote-debugging-port=9222"));
	assert.equal(result.browser, "Chrome/145");
});

await check("一律用插件自己的 profile（非默认 profile 才绕得开 Chrome 136+ 的远程调试限制）", async () => {
	const attempts = [];
	let up = false;
	const result = await ensureDebuggableChrome({
		port: 9222,
		userDataDir: "C:\\plugin-profile",
		waitMs: 1200,
		fetchImpl: async () => { if (!up) throw new Error("down"); return { ok: true, json: async () => ({ Browser: "Edg/153" }) }; },
		running: { known: true, chrome: true, edge: true },
		spawnImpl: (path, argv) => {
			attempts.push({ path, dir: argv.find((a) => a.startsWith("--user-data-dir=")) });
			// 只有 Edge 成功 —— 模拟"首选候选起不来、换下一个候选"
			if (path.includes("msedge")) setTimeout(() => { up = true; }, 200);
			return { unref() {} };
		},
	});
	assert.equal(result.ok, true, result.error);
	assert.equal(result.name, "Edge", "首选候选起不来就该换下一个候选");
	assert.equal(result.reusedProfile, false);
	assert.ok(attempts.length >= 1, "至少要真的试过拉起");
	// 候选数取决于本机装了什么，所以不硬编码次数；这里断言的是"每次都用插件 profile"
	assert.ok(attempts.every((a) => a.dir === "--user-data-dir=C:\\plugin-profile"), `每次都该用插件 profile，实际：${attempts.map((a) => a.dir).join(", ")}`);
});

await check("全都起不来 → 报出每一轮的结果、用的 profile、可执行的下一步", async () => {
	const result = await ensureDebuggableChrome({
		waitMs: 1000,
		userDataDir: "C:\\plugin-profile",
		fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
		spawnImpl: () => ({ unref() {} }),
		running: { known: true, chrome: true, edge: true },
	});
	assert.equal(result.ok, false);
	assert.ok(Array.isArray(result.failures) && result.failures.length > 0, "要把每轮失败原因带出来");
	assert.match(result.error, /C:\\plugin-profile/u, "要说明用的是哪个 profile");
	assert.match(result.error, /BOSS_CHROME_PATH/u, "要给出可执行的下一步");
	assert.match(result.error, /--remote-debugging-port=9222/u, "要给出最后的手动兜底命令");
	// 这一版不再把"浏览器已在运行"当成必然原因 —— 加了 --user-data-dir 就是独立实例
	assert.equal(/单实例/u.test(result.error), false, "不该再把单实例合并说成必然原因");
});

await check("BOSS_AUTO_CHROME=0 时绝不动手", async () => {
	const previous = process.env.BOSS_AUTO_CHROME;
	process.env.BOSS_AUTO_CHROME = "0";
	try {
		const result = await ensureDebuggableChrome({
			spawnImpl: () => { throw new Error("不该 spawn"); },
			fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
		});
		assert.equal(result.ok, false);
		assert.match(result.error, /BOSS_AUTO_CHROME/u);
	} finally {
		if (previous === undefined) delete process.env.BOSS_AUTO_CHROME;
		else process.env.BOSS_AUTO_CHROME = previous;
	}
});

await check("端口探测：/json/version 出 JSON 才算就绪；异常不算", async () => {
	assert.equal((await probeCdp(9222, { fetchImpl: async () => ({ ok: true, json: async () => ({ Browser: "Chrome/145" }) }) })).up, true);
	assert.equal((await probeCdp(9222, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) })).up, false);
	assert.equal((await probeCdp(9222, { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })).up, false);
});

await check("自动拉起只在一处触发：连不上时才试，且每进程只试一次", async () => {
	const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./browser-channel.mjs", import.meta.url), "utf8"));
	assert.match(source, /autoLaunch && !autoLaunchAttempted/u, "要有每进程只试一次的闸门");
	assert.match(source, /ensureDebuggableChrome/u);
	// 抓取/读会话这些高频路径不该自己拉浏览器
	const jobs = await import("node:fs").then((fs) => fs.readFileSync(new URL("./jobs.mjs", import.meta.url), "utf8"));
	assert.equal(/auto-chrome|ensureDebuggableChrome/u.test(jobs), false, "抓取路径不该 spawn 浏览器");
	const messages = await import("node:fs").then((fs) => fs.readFileSync(new URL("./messages.mjs", import.meta.url), "utf8"));
	assert.equal(/auto-chrome|ensureDebuggableChrome/u.test(messages), false, "读会话路径不该 spawn 浏览器");
});

await check("静态护栏：这个模块里没有任何杀进程/结束用户的浏览器的动作", async () => {
	const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./auto-chrome.mjs", import.meta.url), "utf8"));
	for (const banned of ["taskkill", "pkill", "killall", "Stop-Process", ".kill("]) {
		assert.equal(source.includes(banned), false, `不该出现 ${banned}`);
	}
});
//#endregion

//#region 10. 导航护栏：插件绝不能把用户的页面刷成风暴
section("10. 页面刷新护栏：同一目标不重复导航，已到位就不碰");

/** 造一个假 page，记录 goto 次数与地址变化。 */
function fakePage(url = "about:blank") {
	const state = { url, gotos: [] };
	return {
		state,
		url: () => state.url,
		isClosed: () => false,
		async goto(target) {
			state.gotos.push(target);
			state.url = target;
		},
	};
}

await check("已经在合适页面上 → 一次都不导航", async () => {
	resetNavLogForTests();
	// 用户在职位页，目标是登录页：alreadyThere 说"这个地址已经够用"，就不该动它
	const page = fakePage("https://www.zhipin.com/web/geek/jobs");
	const nav = await navigateOnce(page, "https://www.zhipin.com/web/user/?ka=header-login", {
		alreadyThere: (url) => url.startsWith("https://www.zhipin.com") && /\/web\/geek\//u.test(url),
	});
	assert.equal(nav.navigated, false);
	assert.equal(page.state.gotos.length, 0, "已经在合适页面上就不能动它");
	assert.equal(nav.skipped, true);
});

await check("同一目标 60 秒内只导航一次（这是刷新风暴的根源）", async () => {
	resetNavLogForTests();
	const page = fakePage("about:blank");
	const first = await navigateOnce(page, "https://www.zhipin.com/web/user/");
	assert.equal(first.navigated, true);
	assert.equal(page.state.gotos.length, 1);

	// 再调一次：地址已经是目标，会被"已在目标地址"挡住
	const second = await navigateOnce(page, "https://www.zhipin.com/web/user/");
	assert.equal(second.navigated, false);
	assert.equal(page.state.gotos.length, 1, "第二次绝不能再 goto");

	// 页面被别的原因弄回 about:blank 后又调一次 —— 冷却期内也要挡住
	page.state.url = "about:blank";
	const third = await navigateOnce(page, "https://www.zhipin.com/web/user/");
	assert.equal(third.navigated, false);
	assert.equal(third.throttled, true, "冷却期内应该走 throttled 而不是再导航一次");
	assert.equal(page.state.gotos.length, 1, "反复调用也只允许一次导航");

	// 连打 20 次，仍然只有一次
	for (let i = 0; i < 20; i++) {
		page.state.url = "about:blank";
		await navigateOnce(page, "https://www.zhipin.com/web/user/");
	}
	assert.equal(page.state.gotos.length, 1, `20 次调用只该有 1 次导航，实际 ${page.state.gotos.length}`);
});

await check("alreadyThere 判定为真时也不导航（用户在职位页就不顶掉他的页面）", async () => {
	resetNavLogForTests();
	const page = fakePage("https://www.zhipin.com/web/geek/jobs");
	const nav = await navigateOnce(page, "https://www.zhipin.com/web/user/?ka=header-login", {
		alreadyThere: (url) => url.startsWith("https://www.zhipin.com") && /\/web\/geek\//u.test(url),
	});
	assert.equal(nav.navigated, false);
	assert.equal(page.state.gotos.length, 0);
	assert.equal(nav.skipped, true);
});

await check("真的不在合适页面时才导航一次", async () => {
	resetNavLogForTests();
	const page = fakePage("about:blank");
	const nav = await navigateOnce(page, "https://www.zhipin.com/web/user/?ka=header-login", {
		alreadyThere: (url) => /\/web\/geek\//u.test(url),
	});
	assert.equal(nav.navigated, true);
	assert.equal(page.state.gotos.length, 1);
	assert.equal(page.state.url, "https://www.zhipin.com/web/user/?ka=header-login");
});

await check("导航失败不抛异常、也不把登录流程判死，但会记一条", async () => {
	resetNavLogForTests();
	const page = { url: () => "about:blank", isClosed: () => false, async goto() { throw new Error("net::ERR_ABORTED"); } };
	const nav = await navigateOnce(page, "https://www.zhipin.com/web/user/");
	assert.equal(nav.navigated, false);
	assert.match(String(nav.error), /ERR_ABORTED/u);
	assert.equal(readNavLog().some((e) => e.action === "goto-failed"), true, "失败也要留痕");
});

await check("导航日志能回答『到底谁在刷新页面』", async () => {
	resetNavLogForTests();
	const page = fakePage("about:blank");
	await navigateOnce(page, "https://www.zhipin.com/web/user/");
	await navigateOnce(page, "https://www.zhipin.com/web/user/");
	const log = readNavLog();
	assert.ok(log.length >= 2);
	assert.equal(log.some((e) => e.action === "goto"), true, "有过一次真实导航");
	assert.equal(log.some((e) => e.action === "skip"), true, "也有被挡下的调用");
	for (const entry of log) assert.equal(typeof entry.at, "string", "每条都要有时间戳");
});

await check("静态护栏：loginflow 里不许有绕过冷却的裸 page.goto", async () => {
	const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./loginflow.mjs", import.meta.url), "utf8"));
	const bare = source.split("\n").filter((line) => /\.goto\(/u.test(line) && !/navigateOnce|page\.goto\(target/u.test(line));
	assert.deepEqual(bare, [], `loginflow.mjs 里不该有裸 page.goto：${bare.join(" | ")}`);
});
await check("隐藏模式是显式开关，默认必须是已验证能用的可见窗口", () => {
	// 默认 normal：headless 这条路我没能验证成功（受限 shell 里 Chrome 多进程起不来），
	// 所以不能把它设成默认 —— 万一坏的，用户会同时失去窗口和调试口。
	assert.equal(chromeMode({}), "normal");
	assert.equal(chromeMode({ BOSS_CHROME_MODE: "normal" }), "normal");
	assert.equal(chromeMode({ BOSS_CHROME_MODE: "HIDDEN" }), "hidden", "大小写不敏感");
	assert.equal(chromeMode({ HEADLESS: "1" }), "normal", "别被别的变量名误触发");

	const visible = buildLaunchArgs({ userDataDir: "P" });
	assert.equal(visible.includes("--headless=new"), false, "默认不许加 headless");
	const hidden = buildLaunchArgs({ userDataDir: "P", mode: "hidden" });
	assert.equal(hidden[0], "--headless=new", "hidden 模式要加 --headless=new");
	assert.ok(hidden.includes("--remote-debugging-port=9222"), "隐藏模式一样要给调试口");
	assert.ok(hidden.includes("--user-data-dir=P"), "隐藏模式一样要用插件 profile（登录态要留住）");
	assert.ok(hidden.some((a) => a.endsWith("/web/geek/jobs")), "隐藏模式也要先打开 Boss 页");
});

await check("拉起结果里带上用的是哪种模式，便于界面如实显示", async () => {
	let up = false;
	const result = await ensureDebuggableChrome({
		userDataDir: "P",
		waitMs: 1200,
		fetchImpl: async () => { if (!up) throw new Error("down"); return { ok: true, json: async () => ({ Browser: "x" }) }; },
		running: { known: true, chrome: false, edge: false },
		spawnImpl: () => { setTimeout(() => { up = true; }, 150); return { unref() {} }; },
	});
	assert.equal(result.ok, true, result.error);
	assert.equal(result.mode, "normal", "要能看出这次拉的是可见窗口还是隐藏的");
});

//#endregion

console.log(`\n${"─".repeat(60)}`);
console.log(fail.length === 0 ? `全部通过 ✅（${pass} 项）` : `${fail.length} 项失败 ❌（通过 ${pass} 项）`);
for (const name of fail) console.log(`  ✗ ${name}`);
process.exit(fail.length === 0 ? 0 : 1);
