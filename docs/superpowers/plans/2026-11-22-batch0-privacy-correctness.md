# 第 0 批：隐私与正确性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地路线图第 0 批（V1、V2、B1、A1、B2），让标签可见性规则可靠、归档不破坏列表、AI 长输出可用、日语相对时间正确。

**Architecture:** 保持零构建。新增一个纯函数模块 `js/memo-tags.js` 承载标签提取；其余改动落在现有文件里，每个任务一个提交，可单独发布。

**Tech Stack:** Chrome MV3 原生脚本、jQuery、`node --test`（`vm` 加载脚本）。

**Spec:** `docs/superpowers/specs/2026-11-20-optimization-roadmap-design.md`（第 7 节"第 0 批"，第 8 节默认选择 1 生效）

## Global Constraints

- 不引入打包器、TypeScript、框架；页面靠 `<script>` 顺序加载。
- 三种语言（`_locales/zh_CN`、`en`、`ja`）新增词条必须同步，键一致。
- `npm test` 现有 64 项保持通过；有意改变行为时在同一提交更新对应测试。
- 不得导致草稿丢失、重复创建笔记、或把笔记存成比预期更公开的范围。
- 旧设置、旧草稿、旧预设继续可读。
- 只做本地提交，不推送、不改版本号、不打包发布。

## Review Focus

1. 隐藏标签写在围栏代码块 / 行内代码 / 链接文字里：服务端不认作标签，客户端也不应据此改范围（Task 1 测试覆盖）。
2. 层级标签 `#work/secret` 且规则填 `work`：服务端 `tags` 含祖先 `work`，客户端应同样命中（Task 1）。
3. 旧版实例创建响应里没有 `tags` 或 `visibility`：保存后复核必须静默跳过，不报错（Task 2）。
4. 归档撤销请求失败：列表保持"已移除"，提示失败，不能出现已归档条目被渲染回来（Task 3）。
5. 截断且可见文本为空（推理吃光额度）：仍应报错而不是打开空的审阅面板（Task 4）。

---

### Task 1: 标签提取与可见性规则（V1 + V2）

**Files:**
- Create: `js/memo-tags.js`
- Modify: `js/oper.js`（`resolveVisibility`）、`js/settings.js`（`saveTag`）、`popup.html`（在 `js/workspace.js` 前加载 `js/memo-tags.js`）、`tests/memos-compat.test.cjs`（`loadPopup` 加载新文件）
- Test: `tests/memo-tags.test.cjs`

**Interfaces:**
- Produces: `MemoTags.extract(content: string): string[]`（不带 `#`，去重，层级标签同时给出全部祖先）；`MemoTags.normalize(value: string): string`（去首尾空白与开头的 `#`）；`MemoTags.visibility(content, { hidetag, showtag, memo_lock }): string`（隐藏优先，其次公开，否则 `memo_lock || 'PRIVATE'`）。

- [ ] **Step 1: 写失败测试** `tests/memo-tags.test.cjs`，用 `vm` 加载 `js/memo-tags.js`：
  - `extract('见 https://a.com/p#top 然后 #私密')` → `['私密']`
  - `extract('第 #1 条 #私密')` → `['1','私密']`
  - 围栏代码 `` ```c\n#include\n``` ``、行内 `` `#inline` ``、四空格缩进行 → `[]`
  - `extract('[发布 #notes](https://e.com/r#frag) ![#alt](i#f) 外面 #memo-tag')` → `['memo-tag']`
  - `extract('## 标题\n\n# Title\n\n#work/测试 #C++ #R&D.')` → `['work','work/测试','C++','R&D']`
  - `extract('<https://e.com/#x> www.e.com/#y')` → `[]`
  - `visibility('#公开 文本 #私密', {hidetag:'#私密', showtag:'公开', memo_lock:'PROTECTED'})` → `'PRIVATE'`
  - `visibility('#公开', {hidetag:'私密', showtag:'#公开', memo_lock:'PRIVATE'})` → `'PUBLIC'`
  - `visibility('无标签', {hidetag:'私密', showtag:'公开', memo_lock:'PROTECTED'})` → `'PROTECTED'`；规则为空串时不匹配任何内容
  - `visibility('#work/secret', {hidetag:'work', showtag:'', memo_lock:'PUBLIC'})` → `'PRIVATE'`
  - 在 `tests/memos-compat.test.cjs` 加一条：`loadPopup({}, { hidetag:'私密', memo_lock:'PUBLIC', memosDraft… })` 草稿为 `见 https://a.com/p#top #私密` 时 `createMemo` 收到 `visibility === 'PRIVATE'`。
- [ ] **Step 2:** Run `node --test tests/memo-tags.test.cjs` — Expected: FAIL（文件不存在）。
- [ ] **Step 3: 实现 `js/memo-tags.js`。** 先把不参与的区域抹成空格（围栏代码、缩进代码行、行内代码、Markdown 链接/图片整体、`<...>` 自动链接、`scheme://` 与 `www.` 开头的裸网址），再用带 `v` 标志的正则匹配 `#` 后的段：段字符 = `\p{XID_Continue}`、`-`、`+`、`&`、`\p{RGI_Emoji}`，段内允许单个 `'`/`’` 夹在两个字母之间，段之间用单个 `/` 连接。
- [ ] **Step 4:** `resolveVisibility(info)` 改为调用 `MemoTags.visibility`；`saveTag` 保存前对两个输入做 `MemoTags.normalize` 并回写输入框；`popup.html`、`options.html` 加载新脚本；`loadPopup` 的文件列表加 `memo-tags`。
- [ ] **Step 5:** Run `npm test` — Expected: 全部通过。
- [ ] **Step 6: Commit** `修复标签可见性规则：识别正文任意位置的标签，隐藏优先`

### Task 2: 保存后用服务器标签复核（V1 第 4 点）

**Files:**
- Modify: `js/memos-api.js`、`js/oper.js`（`submitMemo`）、`popup.html`、三个 `messages.json`
- Test: `tests/memos-compat.test.cjs`

**Interfaces:**
- Consumes: `MemoTags.normalize`
- Produces: `MemosAPI.setMemoVisibility(info, memoName, visibility): Promise<Memo>` — `PATCH {memoName}?updateMask=visibility`，body `{ visibility }`。页面元素 `#visibilityWarning`（`notice`，默认 hidden）含 `#makePrivate` 按钮。词条 `hiddenTagExposed`、`makePrivate`、`madePrivate`。

- [ ] **Step 1: 写失败测试：**
  - `setMemoVisibility` 发出 `PATCH /api/memos/x?updateMask=visibility`，body `{visibility:'PRIVATE'}`。
  - `loadPopup`，`hidetag:'secret'`，`createMemo` 返回 `{ name:'memos/saved', content, tags:['secret'], visibility:'PUBLIC' }` → `sendText()` 后 `#visibilityWarning` 的 `hidden === false`；调用全局 `makeSavedMemoPrivate()` 后 `setMemoVisibility` 以 `('memos/saved','PRIVATE')` 被调用一次、警告隐藏、最后一条消息为 `madePrivate`。
  - `createMemo` 返回不含 `tags`/`visibility`（旧实例）→ 警告保持隐藏。
  - 返回 `visibility:'PRIVATE'` 且含隐藏标签 → 警告保持隐藏。
- [ ] **Step 2:** Run `node --test tests/memos-compat.test.cjs` — Expected: 新用例 FAIL。
- [ ] **Step 3:** 实现接口、`submitMemo` 成功后的复核、`makeSavedMemoPrivate()`（失败走 `showApiError`，警告保留）、编辑器 `input` 时隐藏警告、页面元素与三语词条。
- [ ] **Step 4:** Run `npm test` — Expected: 全部通过。
- [ ] **Step 5: Commit** `保存后按服务器返回的标签复核可见范围，并提供一键改为私有`

### Task 3: 归档只移除一条并可撤销（B1）

**Files:**
- Modify: `js/workspace.js`、`js/oper.js`、`js/memos-api.js`、`popup.html`、三个 `messages.json`
- Test: `tests/memos-compat.test.cjs`

**Interfaces:**
- Produces: `MemosAPI.restoreMemo(info, memoName)` — `PATCH ?updateMask=state`，body `{ state:'NORMAL' }`；`Workspace.show(memos: Memo[])`（替换当前结果并渲染，随机回顾使用）；`Workspace.remove(name): { memo, index } | null`；`Workspace.restore(entry)`；全局 `archiveMemoByName(name): Promise`、`undoArchive(): Promise`。元素 `#archiveNotice`（hidden）含 `#archiveUndo`。词条 `archiveUndo`、`archiveUndone`。

- [ ] **Step 1: 写失败测试：**
  - 两页搜索（第一页 `memos/a`,`memos/b`，`next:'p2'`；第二页 `memos/c`）：搜索后 `archiveMemoByName('memos/a')` → `#randomlist` 的 HTML 含 `memos/b` 不含 `memos/a`，`#searchMore` 未隐藏；再"加载更多" → 含 `b`、`c`，不含 `a`。
  - 随后 `undoArchive()` → `restoreMemo` 以 `'memos/a'` 被调用，列表重新含 `a`，`#archiveNotice` 隐藏。
  - `restoreMemo` 抛 500 → 列表仍不含 `a`，通知保留。
  - 随机回顾单条：归档后列表为空且 `#randomlist` 被清空。
  - `restoreMemo` 的请求形状（方法、掩码、body）。
- [ ] **Step 2:** Run — Expected: 新用例 FAIL。
- [ ] **Step 3:** 实现。`resetSearch` 同时隐藏 `#archiveNotice` 并丢弃待撤销项；`.random-delete` 点击只转调 `archiveMemoByName`。
- [ ] **Step 4:** Run `npm test` — Expected: 全部通过。
- [ ] **Step 5: Commit** `归档后只移除该条并保留分页，支持撤销`

### Task 4: AI 输出上限可配置，截断结果进入审阅（A1，含 A5 的错误原因）

**Files:**
- Modify: `js/llm-config.js`、`js/ai-optimize.js`、`js/ai-workflow.js`、`js/ai-review.js`、`options.html`、三个 `messages.json`
- Test: `tests/current-release.test.cjs`、`tests/ai-workflow.test.cjs`

**Interfaces:**
- Produces: `LLM_CONFIG.defaults.maxTokens === 8192`；同步存储键 `llmMaxOutputTokens`（整数，256–200000，其余视为 0 = 默认）；`callLLMAPI(...)` 现在 resolve `{ text: string, truncated: boolean }`；`AIWorkflow.review(input, result, task, truncated?)` 在截断时带 `truncated: true`；`AIReview.show(input, result, task, truncated?)`。设置页输入 `#llmMaxTokens`。词条 `aiMaxTokensLabel`、`aiTruncatedWarning`。

- [ ] **Step 1: 改/写失败测试：**
  - 五个传输用例改为断言 `(await callLLMAPI(...)).text === 'answer'`、`truncated === false`；默认上限值为 8192（openai `max_output_tokens`、anthropic/deepseek `max_tokens`、gemini `generationConfig.maxOutputTokens`），newapi 请求体不含 `max_tokens`。
  - 存储 `llmMaxOutputTokens: 4096` 并 `loadLLMState` 后，四种请求体都是 4096，newapi 也带 `max_tokens: 4096`；存 `12`、`'abc'` 回落默认。
  - `{ status:'incomplete', output_text:'partial' }` → resolve `{ text:'partial', truncated:true }`；`{ status:'incomplete', output_text:' ' }` → reject `aiTruncated`。
  - `$.ajax` error `{ status:400, responseJSON:{ error:{ message:'max_tokens too large' } } }` → 错误信息含 `max_tokens too large`；超过 240 字符被截断。
  - `AIWorkflow.review('a','b','summary',true).truncated === true`，不传时对象不含该键。
- [ ] **Step 2:** Run `npm test` — Expected: 上述用例 FAIL。
- [ ] **Step 3:** 实现；`AIReview.renderWarning` 在 `currentReview.truncated` 时追加 `aiTruncatedWarning`；设置页输入随"保存 AI 设置"一起保存。
- [ ] **Step 4:** Run `npm test` — Expected: 全部通过。
- [ ] **Step 5: Commit** `AI 输出上限改为可配置（默认 8192），截断结果进入审阅并显示服务商错误原因`

### Task 5: 用 Intl.RelativeTimeFormat 替换 dayjs（B2）

**Files:**
- Delete: `js/dayjs.min.js`、`js/zh-cn.js`、`js/relativeTime.js`
- Modify: `js/oper.js`、`js/i18n.js`（删 `dayjs.locale` 行）、`popup.html`（删三行脚本）、`tests/memos-compat.test.cjs`、`tests/ai-review.test.cjs`（删 `dayjs` 桩）

**Interfaces:**
- Produces: `relativeTime(value, lang, now = Date.now()): string` 定义在 `js/oper.js`；无效日期返回 `''`；单位阈值：<60 秒用 `second`，<60 分 `minute`，<24 小时 `hour`，<30 天 `day`，<12 个月 `month`，否则 `year`；`numeric: 'always'`。`buildMemoHtml` 以 `document.documentElement.lang` 调用。

- [ ] **Step 1: 写失败测试**（`loadPopup` 上下文）：固定 `now`，3 小时前 → `ja` 得 `3 時間前`，`zh-CN` 得 `3小时前`，`en` 得 `3 hours ago`；`relativeTime('bad','en')` → `''`；2 天前 `en` → `2 days ago`。
- [ ] **Step 2:** Run — Expected: FAIL（`relativeTime` 未定义）。
- [ ] **Step 3:** 实现并删除 dayjs 相关文件、脚本标签、桩。
- [ ] **Step 4:** Run `npm test`；`grep -rn dayjs js tests *.html scripts` — Expected: 测试全过，grep 无结果。
- [ ] **Step 5: Commit** `用内置相对时间格式替换 dayjs，修复日语显示`
