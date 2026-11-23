# 第 3 批：健壮性（R1、R2） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 过大的附件在加入草稿时就被拒绝并说明原因；剪藏一页时抓取的图片有数量、单张大小和总量上限，超出的保留为远程图片链接。

**Architecture:** 保持零构建。上限的判断集中在 `js/staged-files.js`：一个"单个文件上限"取自实例的用量接口（按账号记在本机，一天刷新一次），读不到时用 30 MB。弹窗加文件、Service Worker 抓图都经过它。剪藏另有一个"本次剪藏的预算"对象，记录还能抓几张、还剩多少字节。

**Tech Stack:** 原生脚本、`chrome.storage.local`、`fetch`、`node --test`、ESLint、Prettier。

**Spec:** `docs/superpowers/specs/2026-11-20-optimization-roadmap-design.md`（第 7 节第 3 批：R1、R2。R3–R5 是 P2，不在本计划内）

## Global Constraints

- 不引入打包器、TypeScript、框架。`js/background.js` 的 `importScripts` 清单不变（Service Worker 里没有 `MemosAPI`）。
- 三种界面语言的词条键保持一致；新增词条三种语言同时加，占位符一致。
- `npm run check` 每个任务结束时通过；现有测试保持通过，有意改变行为时在同一提交里改对应测试。
- 数值（规格原文）：单个文件默认上限 30 MB（按 `30 * 1024 * 1024` 字节）；每次剪藏最多抓 30 张图；总量不超过 60 MB（`60 * 1024 * 1024`）。
- 反目标：不得丢草稿、不得重复创建笔记、不得扩大可见范围。被拒绝的文件不得留下半截引用；读不到上限时一律按默认值，不得挡住加文件或保存。
- 已经暂存在 IndexedDB 里的旧文件（可能超过上限）继续可保存，不追溯拒绝。
- 只做本地提交，不推送、不改版本号。
- 不覆盖 `artifacts/` 里已有的验收记录（先备份、跑完恢复，路径用带引号的 POSIX 形式）。

## 实例实测结论（26.11.2）

- `GET /api/users/{id}/usage` 返回 `{ limits: { uploadBytes: "33554432", memoContentBytes: "8192" }, … }`，数值是十进制字符串。旧实例没有这个路由（404）。

## Review Focus

1. 一次选了多个文件，其中一个超限：其余文件照常加入，超限的那个被点名拒绝，草稿里没有它的引用。
2. 读不到实例上限（旧实例、请求失败、存储失败、返回形状不对）：按 30 MB 判断，加文件和保存都不受影响。
3. 图片响应没有 `Content-Length`，或声明的长度是假的：仍然按实际收到的字节数判断。
4. 第 31 张及以后的图片、以及预算用完后的图片：正文里是 `![说明](原地址)`，不是丢失或只剩文字；结果标记为部分成功。
5. 右键"剪藏图片"单张超限：整个操作失败并提示，不向草稿追加任何内容。

---

### Task 1: 单个文件上限（R1）

**Files:**
- Modify: `js/memos-api.js`、`js/staged-files.js`、`js/oper.js`、三个 `_locales/*/messages.json`、`tests/memos-compat.test.cjs`、`tests/staged-files.test.cjs`

**Interfaces:**
- `MemosAPI.uploadLimit(info) → Promise<number | null>`：请求 `users/<id>/usage`，返回 `limits.uploadBytes` 转成的正整数。`null`：`userName` 不是 `users/<id>`、缺路由、400 / 405 / 501、或数值不是正整数。其余错误抛出。
- 存储：`chrome.storage.local` 的 `memosUploadLimits`，形如 `{ "<scope>": { bytes, at } }`。
- `StagedFiles.DEFAULT_LIMIT = 30 * 1024 * 1024`。
- `StagedFiles.limit() → Promise<number>`：从同步存储读当前账号（`apiUrl`、`userName`、`userid`），返回记下的 `bytes`，没有或读失败则返回默认值。不发请求，Service Worker 也能用。
- `StagedFiles.refreshLimit(info) → Promise<void>`：记录不存在或超过一天时调 `MemosAPI.uploadLimit` 并写回；`null` 也记（`bytes` 用默认值），避免旧实例每次都请求。永不抛错。只在页面里调用。
- `StagedFiles.stage(blob, filename, label, reuse, limit)`：`limit` 给定且 `blob.size > limit` 时抛 `Error('fileTooLarge')`，在写入 IndexedDB 之前。
- 词条 `fileTooLarge`：中文"{name} 超过 {limit} 的上传上限，未加入草稿。"，英、日对应；`{limit}` 由 `oper.js` 格式化为一位小数的 MB。
- `oper.js`：`addFiles` 先取一次 `StagedFiles.limit()`，逐个文件暂存；超限的文件各提示一次 `fileTooLarge`，其余照常插入引用并提示 `fileStaged`；全部超限时不提示 `fileStaged`。弹窗启动时（已连接）调一次 `StagedFiles.refreshLimit(info)`。

- [ ] **Step 1: 写失败的测试**
  - `uploadLimit`：路径 `/api/users/tester/usage`；`"33554432"` → `33554432`；404 / 400 / 形状不对 / `"0"` / `"abc"` → `null`；401、500 → 抛出；无 `userName` → `null` 且无请求。
  - `stage`：恰好等于上限通过；多 1 字节抛 `fileTooLarge` 且文件仓库为空；不给 `limit` 时不检查。
  - `limit()`：有记录用记录；别的账号的记录不用；存储读失败用默认值。
  - `refreshLimit`：写入 `{ bytes, at }`；一天内不再请求；`null` 记为默认值；请求失败、写入失败都不抛错且下次重试。
  - 弹窗：三个文件里中间一个超限 → 草稿里是另外两个的引用，提示里有一条含文件名与"30.0 MB"的 `fileTooLarge`；全部超限 → 草稿不变、无 `fileStaged`。
- [ ] **Step 2:** Run — Expected: FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4:** `npm run check`（一致性测试会核对新词条三种语言齐全且被引用）。
- [ ] **Step 5: Commit** `附件加入草稿前检查大小，上限取自实例用量接口，读不到时为 30 MB`

### Task 2: 剪藏图片上限（R2）

**Files:**
- Modify: `js/staged-files.js`、`js/capture-service.js`、`tests/helpers/environments.cjs`（新增 `loadCapture`）、`tests/staged-files.test.cjs`
- Create: `tests/capture-service.test.cjs`

**Interfaces:**
- `StagedFiles.fromUrl(raw, label, budget)`：`budget` 形如 `{ each, left }`（字节）。响应头 `Content-Length` 大于 `min(each, left)` 时不读正文直接抛 `imageCaptureFailed`；读到的 `blob.size` 超过时同样抛出；成功后 `budget.left -= blob.size`。不给 `budget` 时行为不变。
- `CaptureService.add`：
  - 开始时 `budget = { each: await StagedFiles.limit(), left: 60 * 1024 * 1024 }`。
  - 只抓前 30 张；其余以及抓取失败的图片替换为 `remoteImage(image)`：地址是 http(s) 时为 `![说明](地址)`（说明里的方括号和反斜杠转义，地址里的括号写成 `%28` `%29`），否则为说明文字。两种情况都置 `partial = true`。
  - 右键剪藏单张图片（`mode === 'image'`）也带 `budget`；超限时照旧整体失败。
- `loadCapture({ page, fetcher, sync, local })`：在 Service Worker 的替身环境里加载 `draft-storage`、`clipper-core`、`staged-files`、`capture-service`；`chrome.scripting.executeScript` 的第二次调用返回 `page`；返回 `{ capture: CaptureService, files, local, requests }`。

- [ ] **Step 1: 写失败的测试**
  - 40 张图的页面：只产生 30 次抓取；前 30 个标记变成 `memos-local://` 引用，后 10 个是 `![说明](原地址)`；结果 `partial: true`。
  - 单张超过上限：该张保留远程链接，其余照常；`partial: true`。
  - 总量：每张 25 MB（上限按 30 MB），第三张起保留远程链接（60 MB 预算）。用声明大小的假 Blob，不真的分配内存。
  - `Content-Length` 超限：不调用 `blob()`。没有 `Content-Length` 而实际超限：被拒绝。
  - 抓取失败的图片：也是 `![说明](原地址)`（原来只剩说明文字）；`data:` 图片失败时只剩说明文字。
  - 说明里有 `]`、地址里有 `)`：生成的 Markdown 仍是一个完整的图片链接。
  - 右键单张图片超限：`add` 抛错，草稿不变。
  - 不超限的 3 张图：行为与现在一致，`partial: false`。
- [ ] **Step 2:** Run — Expected: FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4:** `npm run check`。
- [ ] **Step 5: 变异验证：** 去掉 30 张的截断 → 测试失败；`budget.left` 不递减 → 总量测试失败。还原。
- [ ] **Step 6: Commit** `剪藏图片限制为每次 30 张、总量 60 MB，超出的保留为远程图片链接`

### Task 3: 浏览器验收、文档与路线图进度

**Files:**
- Modify: `scripts/fixture-server.cjs`、`scripts/check-chrome.cjs`、`README.md`、`docs/superpowers/specs/2026-11-20-optimization-roadmap-design.md`

- [ ] **Step 1:** 测试服务加 `GET /api/users/reader/usage`，上限可由 `state.uploadBytes` 调小。
- [ ] **Step 2:** `check-chrome.cjs` 加一段：把上限调到 10 字节后重开侧栏，选择一个文件 → 出现含文件名的提示，草稿不变，测试服务没有新的上传；恢复上限。
- [ ] **Step 3:** 备份验收目录，对扩展副本带 `MEMOS_BINARY`、`MEMOS_VERSION=26.11.2` 跑 `node scripts/check-chrome.cjs` — Expected: 全部 PASS、零页面错误。恢复备份并核对一致。
- [ ] **Step 4:** README"添加附件"与"剪藏网页"各补一句；路线图状态行加上第 3 批（R1、R2）及提交范围，注明 R3–R5 未做。
- [ ] **Step 5:** `npm run check`。**Commit** `验收脚本覆盖附件大小上限，更新说明与路线图进度`
