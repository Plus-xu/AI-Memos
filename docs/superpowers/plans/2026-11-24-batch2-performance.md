# 第 2 批：性能（F1–F5） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉弹窗里四类重复请求：每次点标签或随机回顾都拉全部笔记、加载更多重下全部私有图片、每次打开都等空间列表、旧实例每次打开都重新探测接口前缀。

**Architecture:** 保持零构建。新增一个小模块 `js/memo-index.js`，按账号把"标签集合"和"笔记资源名列表"缓存在 `chrome.storage.session`，过期后先用旧数据、后台刷新，保存和归档时就地更新。空间列表和接口前缀缓存在 `chrome.storage.local`。结果列表改为"追加新节点"，已下载的图片在同一轮结果里复用。

**Tech Stack:** 原生脚本 + jQuery（现状）、`chrome.storage.session` / `local`、`node --test`、ESLint、Prettier。

**Spec:** `docs/superpowers/specs/2026-11-20-optimization-roadmap-design.md`（第 7 节第 2 批：F1–F5）

## Global Constraints

- 不引入打包器、TypeScript、框架；页面靠 `<script>` 顺序加载，新脚本要写进 `popup.html`。
- 三种界面语言的词条键保持一致（本批不新增词条，复用 `working`、`noTagsFound`、`noMemosFound`、`getTabFailed`、`spaceCheckFailed`）。
- `npm run check`（格式、lint、测试）每个任务结束时通过；现有 158 项测试保持通过，有意改变行为时在同一提交里改对应测试。
- 不改变新旧接口的兼容范围（26.10+ 的 `api/` 与旧版 `api/v1/`）。
- 保存前对空间的强校验（`Workspace.destination`）不变。
- 反目标：任何一步都不得让草稿丢失、重复创建笔记，或把笔记存成比预期更公开的范围。缓存只影响"读"，任何缓存读写失败都退回到直接请求，不得挡住保存。
- 已有的同步设置、草稿、预设继续可读；不动 `memosDestination:*`、`memosSaveAttempt:*` 等现有键。
- 只做本地提交，不推送、不改版本号、不发布。
- 不覆盖 `artifacts/` 里已有的验收记录：跑验收前先备份、跑完恢复（环境见记忆 `e2e-environment`）。

## 实例实测结论（26.11.2，临时库）

路线图要求落地前确认的事项，已对照 `memos.exe` 实测：

- `GET /api/users/{id}:getStats` 存在，返回 `tagCounts: { 标签名: 次数 }`。只统计**本人**的、未归档的笔记（含私有与空间笔记）；子标签 `a/b` 同时计入 `a`。令牌无效或缺失时不返回 401，而是按匿名返回公开部分。用户不存在时 404。
- 列表接口 `GET /api/memos` 不支持 `readMask` / `fields`（参数被忽略，总是返回全文），也不支持按时间戳整数过滤，所以"笔记资源名列表"仍要靠一次全量扫描，只能靠缓存减少次数。默认不含已归档笔记。
- `GET /api/memos/{id}` 对已归档笔记返回 200 且 `state: "ARCHIVED"`，对不存在的返回 404。
- `/api/v1/*` 在新版上对 GET 和 POST 一律返回 410，会被现有的"缺路由则换前缀"逻辑纠正，所以持久化的旧前缀在服务器升级后能自愈。
- 行为差异（有意）：标签列表在新版实例上改为只列本人笔记的标签，不再混入其他用户公开笔记的标签（与 Memos 网页端侧栏一致）。旧实例回退到全量扫描，行为不变。
- 顺带确认 R1（第 3 批用）：`GET /api/users/{id}/usage` 返回 `limits.uploadBytes`（默认 33554432）和 `limits.memoContentBytes`。

## Review Focus

1. `chrome.storage.session` 或 `local` 读写失败（配额、被禁用）：标签、随机回顾、空间、保存都必须照常工作，只是不缓存（Task 1、2、4 各有一条"存储失败"测试）。
2. 切换账号或实例：另一个账号的标签、笔记名、空间不得出现（缓存键含 `DraftStorage.scope(info)`；Task 2、4 的隔离测试）。
3. 缓存里的笔记已在别处被归档或删除：随机回顾不得显示它，要换一条并把它从缓存里去掉（Task 4）。
4. 后台刷新进行中用户保存了带新标签的笔记：刷新结果不得把新标签和新笔记名冲掉（Task 4）。
5. 缓存的空间列表与服务器不一致（空间被移除，或打开时的刷新请求失败）：保存必须仍被拦住，草稿保留（Task 2）。

---

### Task 1: 接口前缀持久化（F5）

**Files:**
- Modify: `js/memos-api.js`、`tests/helpers/environments.cjs`（`loadApi`）、`tests/memos-compat.test.cjs`

**Interfaces:**
- 存储：`chrome.storage.local` 的 `memosApiPrefixes`，形如 `{ "<规整后的实例地址>": "api/v1/" }`。只记旧前缀；`api/` 是默认值，不存。
- `MemosAPI` 通过 `DraftStorage.get` / `put` / `locked` 读写（文件头加 `/* global DraftStorage */`）；读取结果在页面内只取一次。
- `MemosAPI.listSpaces(info)`：已知该实例用 `api/v1/` 时直接返回 `[]`，不发请求（空间只存在于有无版本接口的实例上）。
- `loadApi(responder, fetcher, local = {})`：环境里新增 `chrome`（`createChrome({ local })`）并先加载 `draft-storage`；返回值多一个 `local`。

- [ ] **Step 1: 写失败的测试**（`tests/memos-compat.test.cjs`）
  - 扩展"旧接口探测被缓存"：第二个 `loadApi` 实例共用同一个 `local`，第一次请求直接走 `/api/v1/`；服务器升级（v1 返回 410）后前缀翻回 `api/`，存储里的记录被删除，第三个实例从 `/api/` 开始。
  - 失败的请求不写存储（`local` 仍为空）；默认前缀成功也不写存储。
  - 已知旧实例：`listSpaces` 返回 `[]`，请求数为 0。
  - 存储读取抛错：请求照常成功（走内存里的探测）。
- [ ] **Step 2:** Run `node --test tests/memos-compat.test.cjs` — Expected: 新增断言失败。
- [ ] **Step 3: 实现。** `request()` 先取"内存 → 存储 → `api/`"的前缀；成功后若与已知值不同才写存储，写入失败不影响请求结果。
- [ ] **Step 4:** `npm run check` — Expected: 通过。
- [ ] **Step 5: Commit** `旧实例的接口前缀记在本机，已知旧实例不再请求空间列表`

### Task 2: 空间列表缓存（F4）

**Files:**
- Modify: `js/workspace.js`、`tests/helpers/dom.cjs`（下拉框记录选项）、`tests/helpers/environments.cjs`（`Option`）、`tests/helpers.test.cjs`、`tests/memos-compat.test.cjs`

**Interfaces:**
- 存储：`chrome.storage.local` 的 `memosSpaces:<scope>`，形如 `{ spaces: [{ name, title }] }`。
- `loadDestination`：与目的地一次读出 → 立即用缓存渲染 → 刷新剪藏历史 → 请求空间列表 → 有变化才重绘并写回。`configuring` 仍在刷新结束后才完成，保存时的等待与强校验不变。
- 刷新失败（非缺路由）：提示 `spaceCheckFailed`，保留缓存里的列表。缺路由：列表置空并写回。
- `destination()` 发现列表变化时也写回缓存。
- 替身：页面元素有 `options` 数组，`replaceChildren(...nodes)` 重置它、`add(option)` 追加；`Option` 记录 `text` 与 `value`。

- [ ] **Step 1: 写失败的测试**
  - 有缓存、网络未返回：`#memoSpace` 已列出缓存里的空间。网络返回不同列表后，选项与存储都更新。
  - 列表没变：不重绘、不写存储。
  - 刷新失败：选项仍是缓存里的，提示 `spaceCheckFailed`。
  - 空间被移除后保存：`createMemo` 不被调用，提示 `spaceUnavailable`，草稿原样保留。再测一遍"打开时刷新失败、保存时发现空间已不在"。
  - 另一个账号的缓存不被使用。
  - 存储写入失败：空间照常显示，保存照常进行。
  - `tests/helpers.test.cjs`：替身的 `options` 契约。
- [ ] **Step 2:** Run — Expected: FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4:** `npm run check`。
- [ ] **Step 5: Commit** `打开时先用缓存的空间列表渲染目的地，后台刷新`

### Task 3: "加载更多"只追加（F3）

**Files:**
- Modify: `js/oper.js`、`js/workspace.js`、`tests/helpers/dom.cjs`（`append` 字符串时累加）、`tests/helpers.test.cjs`、`tests/memos-compat.test.cjs`

**Interfaces:**
- `renderMemoList(info, memos)`：重绘当前这一轮结果，**不再释放图片**；列表为空时隐藏容器。
- `appendMemoList(info, memos)`：只追加这些笔记的节点，只为新节点取图。两者都写进 `/* exported */`，`js/workspace.js` 的 `/* global */` 同步。
- 图片缓存：`oper.js` 里一个"地址 → 对象地址"的 Map，同一轮结果内复用；取图失败的条目移除以便重试。`img[data-memos-file]` 表示"还没取图"，开始取图时移除该属性。
- 整体释放只发生在 `clearMemoList()`（新搜索、随机回顾、账号变化）和页面卸载。
- `Workspace.search(true)` 调 `appendMemoList`；`remove` / `restore` 仍重绘，但靠图片缓存不再重新下载。

- [ ] **Step 1: 写失败的测试**
  - 两页结果各带一张私有图片：加载第二页后，第一页图片的请求次数仍为 1，第一页图片元素的 `src` 只被赋值一次。
  - 归档一条、再撤销：其余图片和被归档那条的图片都不重新下载。
  - 新搜索：旧对象地址全部释放，同一张图会重新下载。
  - 取图失败后重绘会重试。
  - `tests/helpers.test.cjs`：`append` 字符串累加到 `html()`。
- [ ] **Step 2:** Run — Expected: FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4:** `npm run check`。现有归档、撤销、预览测试保持通过。
- [ ] **Step 5: Commit** `加载更多只追加新一页，已下载的私有图片不再重复下载`

### Task 4: 标签与随机回顾的缓存（F1、F2）

**Files:**
- Create: `js/memo-index.js`、`tests/memo-index.test.cjs`
- Modify: `js/memos-api.js`（`userTags`）、`js/oper.js`、`popup.html`（`#taglist` 加 `hidden`；在 `memo-tags.js` 之后加载 `memo-index.js`）、`css/main.css`（`.tag-list` 去掉 `display: none`）、`tests/helpers/chrome.cjs`（`session` 区）、`tests/helpers/environments.cjs`（`loadPopup` 第三个参数 `session`、默认 `userTags: async () => null`、加载 `memo-index`）、`tests/helpers.test.cjs`、`tests/memos-compat.test.cjs`

**Interfaces:**
- `MemosAPI.userTags(info) → Promise<string[] | null>`：请求 `users/<id>:getStats`，返回 `tagCounts`（旧版 `tagCount`）里次数大于 0 的标签名。`null` 表示该实例没有可用的统计接口：`info.userName` 不是 `users/<id>`、缺路由、400 / 405 / 501、或返回形状不对。其余错误原样抛出。
- 存储：`chrome.storage.session` 的 `memosIndex:<scope>`，形如 `{ tags, tagsAt, scanned, names, namesAt }`。有效期 10 分钟；`names` 最多 20000 条。
- `MemoIndex`：
  - `tags(info, onRefresh?) → Promise<string[]>`（已排序）。有缓存就立即返回；过期则后台刷新，结果有变化时调 `onRefresh(tags)`。没有缓存则等加载，错误抛出。来源：`userTags`，为 `null` 时全量扫描（同时写入 `names`，并记 `scanned: true`）。
  - `names(info, force?) → Promise<string[]>`。同样的先旧后新；来源是 `MemosAPI.listMemos(info)`。`scanned` 为真时顺带刷新 `tags`。
  - `saved(info, memo)`、`archived(info, name)`、`restored(info, name)`、`forget(info, name)`：就地更新，均不抛错。`saved` 加入笔记名和 `memo.tags`（响应里没有 `tags` 时把标签标为过期）；`archived` / `restored` 增删笔记名并把标签标为过期；`forget` 只删笔记名。
  - 同一账号同一种加载同时只有一轮；加载期间发生的就地更新在加载结果落盘时重放一遍（全是幂等的集合操作）。
- 标签按钮：列表展开或正在加载时再点 → 直接收起，不发请求。收起状态点击 → 显示 `working`，取到后渲染；无标签则收起并提示 `noTagsFound`。保存成功后若列表开着就重绘。显隐改用 `hidden` 属性。
- 随机回顾：`resetSearch` 后显示 `working`；从 `names` 里随机取一个，用 `getMemo` 取单条；404 或已归档则 `forget` 后换一个，最多试 3 个；3 个都不行则强制刷新一次 `names` 再试 3 个；仍没有则提示 `noMemosFound`。

- [ ] **Step 1: 写失败的测试**
  - `tests/memos-compat.test.cjs`：`userTags` 的路径（`/api/users/tester:getStats`）、`tagCounts` 与 `tagCount` 两种形状、次数为 0 的标签被去掉、404 / 400 / 形状不对 → `null`、401 → 抛出、无 `userName` → `null` 且无请求。替身的 `session` 区契约放 `tests/helpers.test.cjs`。
  - `tests/memo-index.test.cjs`（用 `loadPopup`）：
    - 有统计接口：标签来自 `userTags`，已排序，`listMemos` 未被调用。
    - 无统计接口：点击展开、收起、再展开，`listMemos` 只被调用一次。
    - 加载中再点：收起；结果回来后列表保持收起。
    - 过期缓存：先显示旧标签，刷新回来后列表更新、存储更新。
    - 保存带新标签的笔记：开着的列表立即出现该标签；重新打开的弹窗（共用 `session`）不发请求也能看到。
    - 随机回顾两次：`listMemos` 一次、`getMemo` 两次，显示的是 `getMemo` 返回的笔记。
    - 缓存里的笔记已归档 / 404：不显示，换下一条，该名字从缓存里消失；全部失效时强制刷新。
    - 归档后名字被移除、标签标为过期；撤销后名字回来。
    - 另一个账号的缓存不被使用。
    - 两次并发 `tags()` 只有一轮请求。
    - 刷新进行中保存：刷新落盘后新标签和新名字仍在。
    - `session` 存储读写抛错：标签和随机回顾照常工作，保存不受影响。
    - 超过 20000 条名字被截断。
  - 改写受影响的现有测试：随机回顾的桩补上 `getMemo`。
- [ ] **Step 2:** Run — Expected: FAIL。
- [ ] **Step 3: 实现** `userTags`、`js/memo-index.js`，改 `oper.js` 的标签按钮、随机回顾、保存、归档、撤销。
- [ ] **Step 4:** `npm run check`。一致性测试会核对 `popup.html` 加载了 `memo-index.js` 且 `/* global */` 齐全。
- [ ] **Step 5: 变异验证：** 把 `MemoIndex.tags` 改成每次都加载 → "只调用一次"失败；把 `randomMemo` 的归档判断去掉 → "不显示已归档"失败。还原。
- [ ] **Step 6: Commit** `标签与随机回顾改用按账号缓存的索引，优先读用户统计接口`

### Task 5: 浏览器验收、文档与路线图进度

**Files:**
- Modify: `scripts/fixture-server.cjs`、`scripts/check-chrome.cjs`、`scripts/check-live-memos.cjs`、`README.md`、`docs/superpowers/specs/2026-11-20-optimization-roadmap-design.md`

- [ ] **Step 1:** 测试服务补两条路由：`GET /api/users/reader:getStats`（由现有笔记与示例算出 `tagCounts`）、`GET /api/memos/first|second`（示例笔记）。
- [ ] **Step 2:** `check-chrome.cjs` 加一段：点标签 → 出现 `#阅读`；再点 → 收起且期间没有新的请求；点随机回顾 → 显示一条笔记，且全量列表请求只有一次；重开侧栏后空间下拉框在空间请求返回前已有选项（用测试服务的延迟开关）。
- [ ] **Step 3:** `check-live-memos.cjs` 加一段：真实实例上标签列表出现 `#阅读`，随机回顾显示刚保存的笔记；归档后再点随机回顾提示没有笔记。
- [ ] **Step 4:** 备份 `artifacts/` 里当前版本的验收目录与 ZIP，把扩展文件复制到临时目录，带 `MEMOS_BINARY`、`MEMOS_VERSION=26.11.2` 跑 `node scripts/check-chrome.cjs` — Expected: 全部 PASS、零页面错误。恢复备份。
- [ ] **Step 5:** README："查找与回顾"与"本机数据与权限"各补一句（标签与随机回顾的索引按账号缓存在浏览器会话里，10 分钟后后台刷新；空间列表与旧实例的接口前缀记在本机）。路线图：状态行加上第 2 批及提交范围；第 11 节把"是否有统计接口""是否能读到上传上限"两项改为已确认并写明结论。
- [ ] **Step 6:** `npm run check`。**Commit** `验收脚本覆盖标签、随机回顾与空间缓存，更新说明与路线图进度`
