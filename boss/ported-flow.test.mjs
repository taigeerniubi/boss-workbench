import assert from "node:assert/strict";
import test from "node:test";

import {
	assertLoopbackCdpUrl,
	browserJson,
	classifyBossResponse,
	selectExistingBossSession,
} from "./browser-channel.mjs";
import { mapJobDetail } from "./detail.mjs";
import { canRunWatch, computeWatchDelta } from "./watch.mjs";
import { buildReplyAdvice, tailorStructuredResume } from "./career-assistant.mjs";
import { fetchConversation, fetchMessageThreads, normalizeChatMessages, summarizeConversation } from "./messages.mjs";

test("CDP 只允许本机地址，避免把浏览器调试口发到远端", () => {
	assert.doesNotThrow(() => assertLoopbackCdpUrl("http://127.0.0.1:9222"));
	assert.doesNotThrow(() => assertLoopbackCdpUrl("http://localhost:9222"));
	assert.throws(() => assertLoopbackCdpUrl("http://example.com:9222"), /本机/);
});

test("复用已经登录且已经打开的 Boss 页面，不新建浏览器上下文", async () => {
	const otherPage = { url: () => "https://example.com/" };
	const bossPage = { url: () => "https://www.zhipin.com/web/geek/jobs" };
	const anonymous = { pages: () => [otherPage], cookies: async () => [] };
	const loggedIn = {
		pages: () => [otherPage, bossPage],
		cookies: async () => [{ name: "wt2", value: "secret", domain: ".zhipin.com", path: "/" }],
	};
	const picked = await selectExistingBossSession([anonymous, loggedIn]);
	assert.equal(picked.context, loggedIn);
	assert.equal(picked.page, bossPage);
	assert.equal(picked.loggedIn, true);
});

test("页面内请求只执行一次，并携带同源凭证", async () => {
	let calls = 0;
	let input = null;
	const page = {
		url: () => "https://www.zhipin.com/web/geek/jobs",
		evaluate: async (_fn, arg) => {
			calls++;
			input = arg;
			return { status: 200, url: arg.url, json: { code: 0, zpData: { jobList: [] } }, text: "" };
		},
	};
	const result = await browserJson(page, "/wapi/zpgeek/search/joblist.json", { query: "后端", city: "101010100" });
	assert.equal(calls, 1);
	assert.match(input.url, /query=%E5%90%8E%E7%AB%AF/u);
	assert.equal(input.credentials, "include");
	assert.equal(result.json.code, 0);
});

test("36/37/403 都是终止型风控，不应重试或切换通道", () => {
	assert.deepEqual(classifyBossResponse({ code: 36, message: "账号存在异常" }), { kind: "account-risk", terminal: true });
	assert.deepEqual(classifyBossResponse({ code: 37, message: "您的环境存在异常" }), { kind: "environment-risk", terminal: true });
	assert.deepEqual(classifyBossResponse(null, { status: 403, url: "https://www.zhipin.com/web/passport/zp/403.html" }), { kind: "browser-blocked", terminal: true });
	assert.deepEqual(classifyBossResponse({ code: 7, message: "登录状态已失效" }), { kind: "logged-out", terminal: true });
	assert.deepEqual(classifyBossResponse({ code: 0, message: "Success" }), { kind: "success", terminal: false });
});

test("详情接口映射出完整 JD，并保留列表已有字段", () => {
	const mapped = mapJobDetail(
		{ id: "job-1", company: "旧公司", title: "旧标题", jd: "" },
		{
			jobInfo: { encryptId: "job-1", jobName: "资深后端", postDescription: "负责交易系统", salaryDesc: "30-50K", cityName: "北京", areaDistrict: "海淀区" },
			bossInfo: { name: "张女士", title: "招聘经理" },
			brandComInfo: { brandName: "示例科技", industryName: "互联网" },
		},
	);
	assert.equal(mapped.title, "资深后端");
	assert.equal(mapped.company, "示例科技");
	assert.equal(mapped.jd, "负责交易系统");
	assert.equal(mapped.hr, "张女士");
	assert.equal(mapped.area, "海淀区");
});

test("监听只报告新 ID，并执行持久间隔限制", () => {
	const delta = computeWatchDelta(["a", "b"], [{ id: "b" }, { id: "c" }, { id: "d" }]);
	assert.deepEqual(delta.newItems.map((j) => j.id), ["c", "d"]);
	assert.deepEqual(delta.seenIds, ["a", "b", "c", "d"]);

	const now = Date.parse("2026-09-18T10:00:00.000Z");
	assert.equal(canRunWatch({ lastRunAt: "2026-09-18T09:50:00.000Z", minIntervalMinutes: 60 }, now).ok, false);
	assert.equal(canRunWatch({ lastRunAt: "2026-09-18T08:00:00.000Z", minIntervalMinutes: 60 }, now).ok, true);
});

test("结构化简历按 JD 重排已有技能，但不注入简历里没有的技能", () => {
	const tailored = tailorStructuredResume(
		{ name: "张伟", degree: "本科", yoe: 5, skills: ["Java", "Redis", "Docker"], summary: "五年后端经验", experience: [] },
		{ id: "j1", title: "Java 后端", jd: "需要 Java、Redis、Kubernetes 与高并发经验" },
	);
	assert.deepEqual(tailored.resume.skills.slice(0, 2), ["Java", "Redis"]);
	assert.equal(tailored.resume.skills.includes("Kubernetes"), false);
	assert.equal(tailored.gaps.includes("Kubernetes"), true);
	assert.match(tailored.warnings.join(" "), /不应写进简历/);
});

test("聊天记录统一成时间顺序，并判断最新消息是否需要我回复", () => {
	const messages = normalizeChatMessages([
		{ mid: 2, from: { uid: 99 }, to: { uid: 1 }, body: { text: "明天下午方便面试吗" }, time: 200 },
		{ mid: 1, from: { uid: 1 }, to: { uid: 99 }, body: { text: "您好" }, time: 100 },
	], { myUid: 1 });
	assert.deepEqual(messages.map((m) => m.direction), ["outgoing", "incoming"]);
	const summary = summarizeConversation(messages);
	assert.equal(summary.stage, "interview");
	assert.equal(summary.needsReply, true);
});

test("回复建议同时使用 JD、结构化简历和当前会话，且不给虚构承诺", () => {
	const advice = buildReplyAdvice({
		job: { title: "Java 后端", company: "示例科技", jd: "需要 Java、Redis 和高并发经验", salary: "20-30K" },
		resume: { name: "张伟", skills: ["Java", "Redis"], yoe: 5 },
		messages: [{ direction: "incoming", text: "明天下午方便面试吗？", at: "2026-09-18T10:00:00Z" }],
	});
	assert.equal(advice.stage, "interview");
	assert.equal(advice.context.resumeSkills.includes("Java"), true);
	assert.equal(advice.context.jobTitle, "Java 后端");
	assert.equal(advice.drafts.length >= 2, true);
	assert.match(advice.drafts[0].text, /面试|时间/);
});

test("会话列表和历史各走固定的两步请求，不做隐式翻页或重试", async () => {
	const calls = [];
	const transport = {
		request: async (path, params, options) => {
			calls.push({ path, params, options });
			// friendList 每条自带 lastMsg，判断方向要的是 userLastMsg 里的 fromId/toId
			if (path.includes("geekFilterByLabel")) return { status: 200, url: path, json: { code: 0, zpData: { friendList: [{ friendId: 99, name: "李女士", jobName: "Java 后端" }] } } };
			// uid 就是"我"，真实响应一定带；用它省掉一次 getUserInfo
			if (path.includes("userLastMsg")) return { status: 200, url: path, json: { code: 0, zpData: [{ uid: 1, lastMsgInfo: { fromId: 99, toId: 1, showText: "方便聊聊吗" } }] } };
			if (path.includes("getBossData")) return { status: 200, url: path, json: { code: 0, zpData: { data: { securityId: "sec", encryptJobId: "job-1" } } } };
			return { status: 200, url: path, json: { code: 0, zpData: { messages: [{ mid: 1, received: true, body: { text: "方便聊聊吗" }, time: 100 }] } } };
		},
	};
	const threads = await fetchMessageThreads({ transport, save: false });
	assert.equal(threads.ok, true);
	assert.equal(threads.threads[0].needsReply, true);
	// 一次列表 + 一次最近消息，正好两步；uid 拿得到就不该再问 getUserInfo
	assert.equal(calls.length, 2);
	assert.equal(calls[0].options.form, true);
	assert.equal(calls.filter((c) => c.path.includes("userLastMsg")).length, 1, "不能对同一个 friendId 重复请求最近消息");

	calls.length = 0;
	const conversation = await fetchConversation(99, { myUid: 1, transport, save: false });
	assert.equal(conversation.ok, true);
	assert.equal(conversation.messages[0].direction, "incoming");
	// getBossData（拿 securityId）+ historyMsg，两步；historyMsg 只打一页
	assert.equal(calls.length, 2);
	assert.equal(calls[0].path.includes("getBossData"), true);
	assert.equal(calls[1].params.securityId, "sec", "historyMsg 必须带 securityId");
	assert.equal("maxMsgId" in calls[1].params, false, "第一页不该带翻页游标");
});
