# boss-workbench

**Boss 直聘投递流水线工作台** —— 一个 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) Web 客户端插件。

把"刷 Boss、筛岗位、改简历、发招呼、等回复"这条流水线摊成一个三栏工作台：
左边是岗位队列，中间是当前 JD + 打招呼话术，右边是证据（时间线）与素材（简历库）。

> 这个仓库是**插件本体 + 抓取层**。简历按 JD 定制、代发消息那部分还没做。

---

## 它解决什么

Boss 直聘的网页端是给"一次看一个岗位"设计的。真正批量投递时你关心的是另一组问题：

- 手上这一批 JD 各走到哪一步了？（抓到 / 定制中 / 待我确认 / 已发 / 已回复）
- **哪几个在等我？** 三种状态会阻塞在人类这里：待确认、发送失败、招聘者已回复
- 每个岗位该配哪份简历？话术是不是真的引用了 JD 里的要求？
- 这个岗位离我多远？（Boss 只在同城算距离，而且接口里其实没有这个字段 —— 见下）

---

## 架构：浏览器只干一件 HTTP 干不了的事

技术底座是先验证再动手的，结论写进了 [`DESIGN.md`](DESIGN.md) §5、§9：

```
登录那一步           →  无头浏览器（唯一必须用浏览器的环节）
  ① 取二维码            GET  /wapi/zppassport/captcha/randkey
  ② 你扫码 + 手机确认    轮询 scan / scanLogin
  ③ 换登录凭证          GET  /wapi/zppassport/qrcode/dispatcher?fp=<本地生成>
  ④ 过安全验证          ← 只有这一步开浏览器：让 Boss 自己的 JS 写下 __zp_stoken__
  ⑤ 当场验证            GET  /wapi/zpuser/wap/getUserInfo.json → 必须 code 0

之后全部走纯 HTTP        →  Node fetch，不带浏览器
  抓岗位               /wapi/zpgeek/search/joblist.json  或  .../pc/recommend/job/list.json
  打招呼               /wapi/zpgeek/friend/add.json
```

**为什么坚持这样分**：数据全走 JSON 接口，就不依赖 DOM 选择器 —— Boss 改版只影响"过验证"那一步，
不会让解析器一夜之间全废。抓取比浏览器自动化快一个数量级，也安静得多。

---

## 安装

需要 Node ≥ 20、一个能跑的 DSH Web GUI，以及 Playwright（只有登录/修登录态那一步用得到）。

```bash
git clone https://github.com/taigeerniubi/boss-workbench.git
cd boss-workbench
npm install                     # 只装 playwright
npx playwright install chromium
```

然后把它挂进 DSH 的 web profile（`~/.dsh/profiles/web/`）：

**① `package.json` 加一条依赖**（用 `link:` 指到本仓库的 `plugin/` 目录）

```json
{
  "dependencies": {
    "dsh-boss-workbench": "link:<你 clone 下来的路径>/boss-workbench/plugin"
  }
}
```

**② `cordis.patch.yml` 插入插件**

```yaml
- insert:
    - id: boss-workbench
      name: dsh-boss-workbench
```

重启 DSH GUI。左侧栏会出现「Boss 工作台」。

> **改了宿主半边必须重启 GUI。** `plugin/lib/index.js` 是进程启动时加载的，刷新页面换不掉它 ——
> 客户端半边（`client.js`）会热重载，宿主半边不会。往 `cordis.patch.yml` 追加注释试图触发
> live reload 是**无效的**，别白试。

### 数据放在哪：不在这个仓库里

登录凭证、浏览器 profile、简历原件、抓到的东西，**一律不落在仓库目录**，而是放在

```
~/.dsh/boss-workbench/          ← 和 ~/.dsh/.credentials.yaml 里的 key 并排
  data/
    session.json                登录凭证（wt2 / bst / zp_at / __zp_stoken__）
    profile.json                你的城市、关键词、住址坐标（模板见 data.example/）
    jobs.json                   抓到的岗位 + JD 全文
  browser-profile/              浏览器 persistent profile（里面是同一批活 cookie）
  resumes/                      简历原件 + 解析缓存
  runs/                         Boss 原始响应、二维码、回放证据
```

第一次跑任何 `boss/` 下的命令时会自动建好。想换地方：设 `BOSS_HOME=<目录>`。

**为什么这么放**：这些文件里任何一个进了 Git 历史就删不干净了（reflog、fork、缓存都在）。
放在仓库目录外面，是**结构上不可能误提交**，而不是靠"记得加 .gitignore"。
`.gitignore` 里当然也留了一份兜底。

> 从旧布局（数据在仓库目录里）升级：首次运行会把 `data/` `resumes/` `runs/` `.boss-profile/`
> **复制**到新位置。只复制、不删除，你自己确认没问题了再删旧的。

---

## 用起来

### 1. 登录（一次就够）

点开工作台，没登录会自己弹二维码。用 Boss 直聘 APP 扫，手机上点确认。
凭证落在 `~/.dsh/boss-workbench/data/session.json`，浏览器 profile 落在
`~/.dsh/boss-workbench/browser-profile/`。

命令行等价物：`npm run login`

### 2. 找岗位 —— 输入框 + 回车

顶栏那三个条件是**抓取条件**，不是本地筛选器：

| 控件 | 作用 |
|---|---|
| 城市 | 搜索的城市（目前内置 `北京` / `上海` 两个城市码，其余城市要先登录以缓存城市表） |
| 岗位 | 关键词。**输入后回车**（或点右边那颗「搜」）就真去 Boss 搜 |
| 距离 | 抓到之后按距离筛。⚠️ 见下面「距离」一节 |
| 抓取岗位 | 用当前条件抓一批。关键词为空时走**推荐流**（`recommend`） |

抓回来的岗位进 `~/.dsh/boss-workbench/data/jobs.json`，队列跟着它走。已经处理过的岗位
再抓到时会**保留进度**，只刷新 JD 侧的事实 —— 不会把你之前点的状态清零。

CLI 等价物：

```bash
npm run scrape -- --city 北京 --query "后端开发" --pages 1 --yes
```

### 3. 简历库

右下角上传 PDF / Word(.docx) / Markdown，一次可以多份。解析是**本地**做的
（PDF 走 FlateDecode + ToUnicode CMap，docx 走自己的 zip+zlib），**不上传、不做 OCR**。
结构化结果能折叠，可以挂多份、随时切换当前简历。扫出来的扫描件 PDF 会明确告诉你"这是图，解析不了"，
而不是假装成功。

---

## 距离这件事，先说清楚

**Boss 的岗位列表接口里没有距离，也没有坐标。** 实测 `jobList` 只给 `cityName` 和 `areaDistrict`。

所以卡片上会出现三种状态，我不会编数字：

| 显示 | 含义 |
|---|---|
| `3.2km` | 有坐标，和你的住址算出来的（Haversine） |
| `距离未知` | 同城，但既没坐标也没商圈表 —— **不猜** |
| `异地` | 不同城，距离本身就没意义 |

想让 `距离未知` 变少，就在 `data/geo.json` 里建一张「商圈 → 坐标」表：

```json
{ "海淀区·中关村": { "lng": 116.31, "lat": 39.98 } }
```

配合 `data/profile.json` 里的 `homeGeo`，没有的商圈继续显示「距离未知」。

---

## 风险与边界（请务必读）

这是**在真实账号上操作**的工具，不是沙盒里的 demo。

- **`code 35` 是紧急刹车。** 见到 `您的IP地址存在异常行为` / `您的账户存在异常行为`，
  代码会立刻停手、不重试。风控是按**行为频率**扣分的，硬撞只会把分推得更高。
  本项目开发过程中就因为连续发探针把账号从 IP 级风控推到了**账号级**风控。
- **页间默认 3~8 秒随机延时、默认 3 页、上限 10 页；不带 `--yes` 只打印计划、完全不碰网络。**
- 短期大量抓取 / 打招呼违反 Boss 的用户协议，账号有被限制的风险。**自己判断要不要用。**
- 凭证（`~/.dsh/boss-workbench/data/session.json`、`browser-profile/`）等于你的登录态。
  **它们放在仓库目录外面，结构上就不会被提交** —— 但如果你为了"方便分享"手动拷进仓库，
  推上去就再也删不干净了。别这么干。

---

## 仓库里有什么

```
plugin/lib/client.js      工作台 UI（三栏、状态机、简历库、登录闸门、余额）
plugin/lib/index.js       宿主半边：/boss 前缀下的 HTTP 路由（那座桥）
boss/lib.mjs              抓取层公共库：会话/fp/城市/距离/风控信号
boss/jobs.mjs             抓取内核 runScrape() —— CLI 和 UI 按钮共用同一份
boss/loginflow.mjs        扫码登录状态机
boss/repair-session.mjs   不用重扫码修登录态（旧 __zp_stoken__ 导致的 code 37）
boss/parse.mjs            简历解析（PDF / docx / Markdown，本地，无 OCR）
boss/resumes.mjs          简历库索引与落盘
boss/greet.mjs            打招呼话术（规则式，只引用真正匹配上的点）
boss/balance.mjs          DeepSeek 账号余额
smoke.mjs                 129 条冒烟断言（自带迷你 React，能驱动任意状态分支）
DESIGN.md                 设计文档，含所有实测结论与踩过的坑
preview/*.html            离线预览（假数据，用浏览器直接打开）
```

**未纳入仓库**（都在 `.gitignore` 里，各有原因）：本机一次性侦察脚本 `probe-*.mjs`、
`RECON-browser-automation.md`（写死了绝对路径）；`ref/`（第三方参考实现，无 LICENSE）；
`preview/*.png`（截图会露出会话标题与简历文件名）。

运行期数据（`data/` `resumes/` `runs/` `browser-profile/`）**根本不在仓库目录里** ——
见上面「数据放在哪」。

---

## 验证

```bash
npm test          # smoke.mjs，129 条
npm run test:parse
```

`smoke.mjs` 不是快照测试：它带一个**能真的 setState、真的跑 effect** 的迷你 React，
把每个状态分支驱动出来断言。加它是为了一个具体的 bug —— "列表永远停在演示数据"
这条路上的问题，effect 是空桩的测试根本看不见。

`bridge.test.mjs` 打的是**正在运行**的 GUI 的真实路由，会验证鉴权、`/boss/state`、
以及 `/boss/scrape` 在联网之前就挡住非法城市。它 404 时说明宿主半边还没重载。

---

## 还没做

- agent 按 JD 定制简历（目前是占位按钮）
- 在 UI 里真发打招呼（宿主路由 `POST /boss/greet/send` 已经在了，UI 没接）
- 回复消息的收取与代回
- 距离的「商圈 → 坐标」表（需要坐标数据源）

## 参考

浏览器自动化的分工思路来自 [mucsbr/mcp-bosszp](https://github.com/mucsbr/mcp-bosszp)
（**只参考思路，不调用它的服务**，代码也是各写一份）。它只用了推荐流接口，
搜索接口、简历解析、工作台 UI 都是本项目自己的。

## License

MIT
