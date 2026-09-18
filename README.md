# boss-workbench

Boss 直聘求职流水线的 DSH 工作台插件。它把岗位搜索、完整 JD、监听、简历微调、会话读取和回复建议放进同一个三栏界面。

当前实现的核心原则是：**复用你已经打开并登录的真实 Chrome/Boss 页面**。插件不启动独立无头浏览器，不把旧 cookie 注入新 profile，也不会在风控后自动切换通道重试。

## 已实现

- 连接本机 Chrome DevTools（默认 `127.0.0.1:9222`），复用已有 context 和 Boss 标签。
- 搜索/推荐岗位；城市、薪资、经验、学历、类型、行业、规模、融资阶段筛选（下拉项由宿主字典下发，本地按字段复核）。
- 单页抓取默认值，35/36/37/403/429 终止型熔断与持久冷却。
- 单条、按需获取完整 JD；不会在列表加载后自动补 30 条详情。
- 保存监听条件，手动检查新岗位，按岗位 ID 去重；最短间隔默认 6 小时。
- 本地解析 PDF、docx、Markdown 等简历并生成结构化索引。
- 按 JD 润色结构化简历：前置匹配技能/经历，逐段给出 before → after，只使用原简历已有事实，明确列出缺口。
- 显式读取当前岗位对应的 Boss 会话和最近消息（会话列表 → 最近消息 → `getBossData` → 历史消息，带 `maxMsgId` 翻页）。
- **用模型写"待发送的句子"**：给定「JD + 我的结构化简历 + 当前会话」，生成 2–3 条候选回复。
- 句子填进输入框可以随便改，**你按「发送给 HR」才真的发出去**；发完能读到 HR 的回复，再点「刷新并换一句」生成下一句。
- 打招呼：用「简历 + JD」生成话术，你可以直接改，改完的话术会被原样发出。

参考项目仅用于理解接口和流程；本仓库没有 import、调用或依赖它们的代码。

## 回复是怎么工作的（模型只写句子，发送由你按）

这条链上**模型只做一件事**：把"该回什么"写成一句可以原样发送的中文。它不跟 HR 对话、
不决定要不要回、不自动循环、更不发送。整条链路是：

```text
读会话 ──► 模型写句子 ──► 你看到/可以改 ──► 你按「发送给 HR」 ──► 消息到 HR
   ▲                                                                  │
   └──────────── 点「刷新并换一句」，把 HR 的最新回复读回来 ◄───────────┘
```

具体分工：

| 步骤 | 谁做的 | 代码 |
|---|---|---|
| 读会话（含 HR 最新回复） | 协议调用，**不经过模型** | `boss/messages.mjs` 的 `fetchConversation` |
| 判断"要不要我回"、阶段是面试/薪资/简历 | 规则，稳定且可离线测 | `boss/career-assistant.mjs` 的 `buildReplyAdvice` |
| 写出候选句子 | **模型**（DeepSeek `deepseek-chat`） | `boss/reply-llm.mjs` 的 `draftWithLlm` |
| 发送 | **只有你按下按钮** | `boss/messages.mjs` 的 `sendReply` + `boss/mqtt-chat.mjs` |

模型写句子时被写死的三条硬约束（`boss/reply-llm.mjs` 的 `SYSTEM_PROMPT`）：

1. 只使用简历里的事实，**绝对不许编造**经历、技能、公司、头衔、数字；
2. **不许替你承诺**薪资底线、入职时间、面试时间 —— 需要确认的一律写成提问；
3. 只返回 JSON，每条 ≤120 字，不加 emoji / Markdown。

规则那边还有两条**永远覆盖不掉**的禁令，会拼在模型结果后面一起显示：
"不要虚构简历中不存在的经历、技能或数字"、"不要在未确认前承诺入职时间、薪资底线或面试安排"。

**降级是可见的。** 没有 key、请求失败、模型没吐 JSON —— 一律退回规则模板，
并在界面上把标签从「模型写的（deepseek-chat）」换成红色的「模板句（模型没参与）」，
同时把原因写在下面。不会让人误以为模板是模型写的。

想只用模型、不接受降级，就在请求里给 `engine: "model"`（界面默认是 `"auto"`，
模型挂了退回模板；`"rules"` 则完全不走模型）。

key 从哪来：宿主凭据服务的 `DEEPSEEK_API_KEY` / `deepseek-official`，
退不回就读 `~/.dsh/.credentials.yaml`。**key 只在宿主侧用，不下发到浏览器**
（浏览器直连 `api.deepseek.com` 也会被 CORS 挡掉）。

## 发消息是怎么走的（唯一写操作）

求职端**没有**发消息的 HTTP 接口 —— 这一点两个参考项目都印证了。Boss 的实时聊天走
MQTT over WebSocket：

```text
wss://ws6.zhipin.com:443/chatws     topic "chat"，QoS 1，retain=false
username = <getUserInfo.json 的 zpData.token> + "|0"
password = </wapi/zppassport/get/wt 的 zpData.wt2>
WS 头     Origin + 全部 Cookie（不带 Cookie 连 101 升级都过不去）
载荷      手写 Protobuf TechwolfChatProtocol（字段号见 boss/mqtt-chat.mjs）
```

`boss/mqtt-chat.mjs` 用 Node 自带的 `WebSocket` 实现了最小的 MQTT 客户端（CONNECT / PUBLISH /
PINGREQ / DISCONNECT）和这份 schema 的 Protobuf 编码器，**没有引入 mqtt.js 或 paho 之类的运行时依赖**。

三层闸门，防止误发：

1. 界面上点「发送给 Boss」后还要过一次 confirm；
2. 请求体必须显式带 `confirm: true`，否则宿主返回 428 直接拒绝；
3. 宿主侧还有 3 秒最小发送间隔、2 分钟内同内容去重，发送记录写在 `sent-messages.json`。

发送**失败不重试**：MQTT 重发等于对 Boss 连发两条，宁可让你自己再点一次。

插件**不会替你上传简历附件** —— 打招呼只发消息。「就这样，发送」的文案已按这个事实改写。


## 安装

需要 Node.js 20+、DSH Web GUI 和 Playwright。

```bash
git clone https://github.com/taigeerniubi/boss-workbench.git
cd boss-workbench
npm install
```

把插件挂到 `~/.dsh/profiles/web/package.json`：

```json
{
  "dependencies": {
    "dsh-boss-workbench": "link:<仓库绝对路径>/plugin"
  }
}
```

在 `cordis.patch.yml` 插入：

```yaml
- insert:
    - id: boss-workbench
      name: dsh-boss-workbench
```

修改 `plugin/lib/index.js` 或 `boss/*.mjs` 后需要重启 DSH GUI；只刷新网页不会重载宿主进程。

## 启动真实 Chrome 会话

先彻底退出正在运行的 Chrome，再用一个固定的调试 profile 启动：

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --remote-allow-origins=* `
  --user-data-dir="$env:LOCALAPPDATA\boss-workbench-chrome"
```

如果 Chrome 安装在 `Program Files (x86)`，相应调整可执行文件路径。也可以设置：

```powershell
$env:BOSS_CDP_URL = "http://127.0.0.1:9222"
```

安全限制：CDP 地址只允许 `localhost`、`127.0.0.1` 或 `::1`，防止把浏览器调试能力暴露给远端。

然后：

1. 在该 Chrome 中打开 `https://www.zhipin.com/web/geek/jobs`。
2. 正常登录并完成人机验证。
3. 保持该 Boss 标签打开。
4. 打开 DSH 的「Boss 工作台」，点击重新连接。

插件第一次绑定只在当前页面里发一次 `getUserInfo` 校验。之后页面挂载只读取本机浏览器状态，不反复访问 Boss。

## 使用流程

### 1. 搜岗位和筛选

工作台支持：

- 城市与关键词
- 薪资、经验、学历、全职/实习/兼职
- 行业、公司规模、融资阶段
- 本地距离筛选

点击「抓取岗位」只抓 1 页。命令行等价操作：

```bash
npm run scrape -- --city 北京 --query "后端开发" --pages 1 --yes
```

命令行同样要求 9222 中已有登录并打开的 Boss 页面。不带 `--yes` 只打印计划。

### 2. 获取完整 JD

列表接口经常不返回正文。选中岗位后点击「获取完整 JD」才请求一次详情接口。失败或遇到风控不会再尝试 job-card、Node 直连等第二通道。

### 3. 监听岗位

「保存监听」只保存当前搜索和筛选条件，不联网。「检查新岗位」才执行一次单页搜索并和历史 `seenIds` 比较。

- 默认最短间隔：6 小时
- 最低允许值：30 分钟
- 没有后台 `setInterval`
- 风控冷却期间不能运行

### 4. 按 JD 润色简历

先上传并解析简历，再选择岗位并取得 JD，点击「按 JD 微调」。结果写入：

```text
~/.dsh/boss-workbench/data/tailored-resumes.json
```

规则版润色会：

- 把原简历中和 JD 匹配的技能前置；
- 把包含匹配技能的经历要点前置；
- 生成面向当前岗位的摘要；
- 给出逐段的 **原 → 改** 对照（技能 / 个人摘要 / 经历要点各一段），而不是只说"已优化"；
- 把 JD 要求但简历没有证据的技能列为 gap，而不是写成“已掌握”。

它不覆盖原始简历文件，也不编造工作经历、头衔或量化数字。

### 5. 获取会话和回复

选中岗位后点击「读取会话并生成建议」。插件显式执行：

1. 一次沟通列表请求（`POST /wapi/zprelation/friend/geekFilterByLabel`，form：`labelId` + `page`）；
2. 一次（会话超过 20 个则多次）最近消息请求（`GET /wapi/zpchat/geek/userLastMsg?friendIds=`，每批 ≤20）；
3. 匹配当前岗位对应的 `friendId`；
4. 一次 `getBossData`（拿 `securityId`，历史消息必须带它）；
5. 历史消息请求（`GET /wapi/zpchat/geek/historyMsg`，`gid` / `c` / `src=0` / `securityId`，翻页靠 `maxMsgId`）；
6. 用 JD、当前结构化简历和会话生成回复草稿。

回复建议会区分面试安排、薪资、简历请求、普通沟通和等待状态。草稿在界面上可以直接改，
确认后通过「发送给 Boss」真的发出去（走 MQTT，见上文的三层闸门）。插件不会自动回复、
也不会在读取会话时顺手发任何东西。

## 运行期数据

默认全部放在仓库外：

```text
~/.dsh/boss-workbench/
  data/
    session.json
    jobs.json
    watch.json
    conversations.json
    conversation-<friendId>.json
    tailored-resumes.json
    resumes.json
    cooldown.json
    sent-messages.json
  resumes/
  runs/
```

可用 `BOSS_HOME` 改位置。cookie、聊天记录和简历均属于敏感信息，不要复制进 Git 仓库。

「解除绑定」只清插件保存的 `session.json` 和内存状态，**不会退出或清理真实 Chrome 中的 Boss**。

## 风控策略

- `code 35`：IP 风控，冷却 2 小时。
- `code 36`：账号风控，冷却 24 小时。
- `code 37`：环境风控，冷却 2 小时；明确为 token 失效时按登录失效处理。
- HTTP 403/验证页：冷却 2 小时。
- 429/`code 9`：冷却 1 小时。
- 风控响应是终止态：不重试、不换 Node/浏览器通道、不启动新 profile。
- CLI 不提供忽略冷却的开关。
- 多页抓取默认 1 页，上限 5 页；页间 5–9 秒随机延时。
- 发消息额外有 3 秒最小间隔 + 2 分钟同内容去重；发送失败不重试。

## 主要模块

```text
plugin/lib/client.js       三栏 UI、登录闸门、筛选、JD、监听、简历润色、会话与发送交互
plugin/lib/index.js        /boss 本机鉴权路由
boss/browser-channel.mjs   CDP 连接、现有页面复用、页面内 fetch、风控分类
boss/loginflow.mjs         真实 Chrome 登录绑定状态机
boss/jobs.mjs              搜索/推荐岗位、筛选参数、本地距离过滤
boss/detail.mjs            单条 JD 详情（一次请求同时带 securityId 与 encryptJobId）
boss/watch.mjs             监听保存、间隔限制和增量去重
boss/messages.mjs          沟通列表、最近消息、会话历史、阶段摘要、发消息
boss/mqtt-chat.mjs         MQTT over WSS + Protobuf 编码器（真正把消息发出去）
boss/reply-llm.mjs         用模型写"待发送的句子"（prompt / JSON 容错 / 降级）
boss/career-assistant.mjs  简历润色、阶段判断、规则版兜底句子
boss/parse.mjs             本地简历解析
boss/resumes.mjs           简历索引
```

## 验证

```bash
npm test
```

标准测试全部离线：UI 冒烟、浏览器通道契约、风控分类、JD 映射、监听去重、简历润色、
会话归一化、模型 prompt 与 JSON 容错、简历解析和 import 检查。它们不会登录或访问 Boss。

模型那部分也是离线的：`boss/contract.test.mjs` 注入假的 `fetch` 与假的 key，
断言 prompt 里带了什么、模型吐出的畸形 JSON 怎么处理、失败时降级标签对不对 ——
**不需要真调用模型，也不消耗额度**。

`boss/contract.test.mjs` 专门盯**接口契约**：路径、参数名、响应字段名、筛选字典的每个码，
以及 MQTT/Protobuf 的字段号和 CONNECT/CONNACK 字节布局。它拦的是"参数名记错但代码不报错、
只静默返回空数据"这类 bug —— 这个插件最容易出、也最难发现的就是这一类。

`npm run test:bridge` 会连接正在运行的 DSH GUI，只用于本机路由集成检查；不要把它当 Boss 线上测试。

## 参考与许可边界

- [can4hou6joeng4/boss-agent-cli](https://github.com/can4hou6joeng4/boss-agent-cli)：参考现有浏览器会话、终止型风控、`friend/add.json` 的 form 参数、简历润色 prompt 的字段形状。
- [DuanXiaoWen/zhipin-geek](https://github.com/DuanXiaoWen/zhipin-geek)：参考求职端消息接口顺序与参数名、筛选码字典、`friendId` 语义，以及发消息的 MQTT/Protobuf 协议（这是唯一在真实账号上跑通"给 Boss 发消息"的路径）。

本插件使用自己的 JavaScript 实现；不会运行、import 或复制上述项目的源码文件。
