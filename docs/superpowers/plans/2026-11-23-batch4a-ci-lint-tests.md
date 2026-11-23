# 第 4 批前半：CI、代码检查与测试桩抽离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地路线图 E1、E2，以及它们依赖的 E7 两项（统一换行符、删除无引用词条），让每次改动都有格式、lint、单元测试和一致性检查兜底。

**Architecture:** 保持零构建。ESLint 与 Prettier 只是开发依赖，不进发布包。跨文件的全局依赖写在各脚本顶部的 `/* global */`、`/* exported */` 注释里，由 ESLint 保证不多不少，再由一条不依赖 `node_modules` 的测试按页面实际加载顺序核对这些名字是否存在。四个测试文件各自的桩抽到 `tests/helpers/`，测试体不改。

**Tech Stack:** Node ≥ 22.13、`node --test`、ESLint 10（平面配置）、Prettier 3、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-11-20-optimization-roadmap-design.md`（第 7 节 E1、E2，E7 中的 `.gitattributes`、`.editorconfig` 与 20 条词条）

## Global Constraints

- 不引入打包器、TypeScript、框架；页面靠 `<script>` 顺序加载。
- `js/` 下的改动只限：格式化、顶部注释、等价改写、删除无引用代码。不改行为。
- `npm test` 现有 99 项保持通过，且不安装依赖也能运行（只用 Node 内置模块）。
- 三种语言的词条键保持一致。
- 发布包文件清单不变（`scripts/package-extension.ps1` 的白名单不动）。
- 只做本地提交，不推送、不改版本号、不发布。CI 工作流因此无法在 GitHub 上实跑，只能本地逐条执行其命令。
- 不覆盖 `artifacts/` 里已有的验收记录：打包输出到临时目录，跑验收前先备份、跑完恢复。
- 依赖版本写死（与现有 `devDependencies` 一致），安装用 `npm install --ignore-scripts`。

## Review Focus

1. 在 `core.autocrlf=true` 的 Windows 上全新检出：`npm run format:check` 必须通过，重新生成的剪藏库必须与仓库一致（Task 1、2 的克隆验证）。
2. Node 22（声明的最低版本）上 `npm test` 必须能跑：现在的 `--test-isolation=none` 在 22.x 上直接报错（Task 1）。
3. 格式化三个 HTML 后，三种语言 × 两种主题下每个元素的位置与尺寸不变，渲染文字不变（Task 2 的布局对比）。
4. 某个页面漏加一个 `<script>`（第 0 批里 `options.html` 就差点漏掉 `memo-tags.js`）：一致性测试必须失败（Task 6 的变异验证）。
5. 抽离测试桩后测试"因为桩变宽松而通过"：五个测试文件的 `test(...)` 体必须逐字不变（Task 4 的机械比对）。

---

### Task 1: 统一换行符，修正最低 Node 版本

**Files:**
- Create: `.gitattributes`、`.editorconfig`
- Modify: `package.json`（`scripts.test`、`engines`）、`README.md`（开发环境一节的 Node 版本）

- [ ] **Step 1:** 复现：用 Node 22.x 跑 `node --test --test-isolation=none tests/*.test.cjs` — Expected: `bad option`。
- [ ] **Step 2:** `.gitattributes` 写 `* text=auto eol=lf`，`*.png binary`。`.editorconfig`：UTF-8、LF、文末换行、两空格缩进、去行尾空白；`*.md` 不去行尾空白。
- [ ] **Step 3:** `scripts.test` 改为 `node --test tests/*.test.cjs`；`engines.node` 改为 `>=22.13.0`（ESLint 10 的要求）；README 同步。
- [ ] **Step 4:** `git add --renormalize .` 后索引无变化；把工作区里 CRLF 的文件重新检出；`git ls-files --eol | grep -c 'w/crlf'` — Expected: `0`。
- [ ] **Step 5:** `npm test` 在本机 Node 与 Node 22.x 上都是 99 通过。
- [ ] **Step 6: Commit** `统一换行符为 LF，修正 npm test 在 Node 22 上无法运行的问题`

### Task 2: Prettier 与首次格式化

**Files:**
- Create: `.prettierrc.json`、`.prettierignore`、`.git-blame-ignore-revs`
- Modify: `package.json`、`package-lock.json`；格式化全部自有 `js`、`cjs`、`css`、`html`、`json`

**Interfaces:**
- Produces: `npm run format`（`prettier --write .`）、`npm run format:check`（`prettier --check .`）。配置：`printWidth: 120`、`singleQuote: true`、`trailingComma: "none"`、`arrowParens: "avoid"`；HTML 空白处理用默认的 `css` 模式（实测 `ignore` 模式会多渲染出几个空格）。

- [ ] **Step 1:** 忽略清单：`js/vendor/`、`js/jquery.min.js`、`js/view-image.js`、`_metadata/`、`package-lock.json`、`*.md`、`.superpowers/`、`.claude/`。
- [ ] **Step 2:** 格式化前，在仓库外的临时脚本里对 `popup.html`、`panel.html`、`options.html` 取布局快照（三种语言 × 两种主题 × 默认与强制展开两种状态：每个元素的标签、id、class、取整后的矩形、`display`，以及 `body.innerText`）。
- [ ] **Step 3:** `npx prettier --debug-check .` — Expected: 退出码 0（语法树等价）。
- [ ] **Step 4: Commit（配置）** `新增 Prettier 配置与格式化脚本`
- [ ] **Step 5:** `npm run format`；再跑一次确认无新改动；`npm test` 99 通过；重取布局快照并比对 — Expected: 矩形差异 0，`innerText` 差异 0。
- [ ] **Step 6: Commit（仅格式化）** `用 Prettier 统一格式化全部自有代码（无逻辑改动）`
- [ ] **Step 7:** 把上一个提交的完整哈希写进 `.git-blame-ignore-revs`，并在 README 开发一节写一句 `git config blame.ignoreRevsFile .git-blame-ignore-revs`。
- [ ] **Step 8:** 用 `git clone -c core.autocrlf=true` 克隆到临时目录，装依赖后 `npm run format:check`、`node scripts/vendor-clipper.cjs && git diff --exit-code` — Expected: 都通过。
- [ ] **Step 9: Commit** `让 git blame 跳过格式化提交`

### Task 3: ESLint

**Files:**
- Create: `eslint.config.mjs`
- Modify: `package.json`、`package-lock.json`；`js/*.js`（顶部 `/* global */`、`/* exported */`）；下列七处；`tests/memos-compat.test.cjs`（先补一条测试）

**Interfaces:**
- Produces: `npm run lint`（`eslint .`）；`npm run check`（`format:check` + `lint` + `test`，与 CI 一致）。
- 规则：`@eslint/js` recommended + `eqeqeq`（现有 0 处违反）+ `no-unused-vars` 取 `vars: 'all'`。不开 `no-var`（165 处，且顶层 `var` 是有意的全局写法）。
- 全局变量：`js/` 下页面脚本用 `globals.browser` 加 `chrome`、`$`、`jQuery`、`ViewImage`；`js/background.js` 另加 `globals.serviceworker`；`scripts/`、`tests/`、`*.cjs` 用 `globals.node`。忽略 `js/vendor/`、`js/jquery.min.js`、`js/view-image.js`、`artifacts/`、`.superpowers/`、被 `.gitignore` 忽略的目录。
- 约定：每个页面脚本用 `/* global A, B */` 列出它用到的其他文件的名字，用 `/* exported X */` 列出只被其他文件使用的顶层名字。多写或少写都会被 lint 报出来。

- [ ] **Step 1: 先写测试**（改正则之前固定行为）：`renderMarkdownPreview` 对标签里带转义方括号和反斜杠的链接（`[a\[1\]\\b](https://e.com)`）输出的文字是 `a[1]\b`。Run — Expected: PASS（描述现状）。
- [ ] **Step 2:** 写配置，`npm run lint` — Expected: 386 处 `no-undef` 加下面七处。
- [ ] **Step 3:** 给各文件补 `/* global */`、`/* exported */`，直到只剩七处。
- [ ] **Step 4:** 逐个处理：
  - `no-useless-escape` ×3（`js/clipper-core.js`、`js/clipper.js`、`js/oper.js`）：去掉字符类里多余的反斜杠。
  - `js/model-catalog.js` `preserve-caught-error`：抛新错误时带上 `{ cause: error }`。
  - `js/model-catalog.js` `no-control-regex`：有意为之，加带理由的单行禁用注释。
  - `js/model-catalog.js` `no-constant-condition`：`do {…} while (true)` 改为 `while (true) {…}`。
  - `scripts/check-live-memos.cjs` `no-unsafe-finally`：`finally` 里不再抛错，改为跳过删除、`console.error` 并置 `process.exitCode = 1`。
  - 删除无调用方的 `saveLLMConfig`（`js/ai-optimize.js`）和 `js/llm-config.js` 末尾无人 `require` 的 `module.exports` 分支。
- [ ] **Step 5:** `npm run check` — Expected: 0 问题，99+1 通过。
- [ ] **Step 6: 变异验证：** 在任一文件里用一个未声明的跨文件名字 → lint 报错；在 `/* global */` 里多写一个不用的名字 → lint 报错。还原。
- [ ] **Step 7: Commit** `新增 ESLint，声明各脚本的跨文件依赖并修复其报出的七处问题`

### Task 4: 抽离测试桩

**Files:**
- Create: `tests/helpers/scripts.cjs`、`tests/helpers/dom.cjs`、`tests/helpers/chrome.cjs`、`tests/helpers/environments.cjs`
- Modify: `tests/ai-review.test.cjs`、`tests/ai-workflow.test.cjs`、`tests/current-release.test.cjs`、`tests/memos-compat.test.cjs`、`tests/memo-tags.test.cjs`（只改文件头）

**Interfaces:**
- Produces:
  - `scripts.cjs`：`root`、`source(name)`（读 `js/<name>.js`）、`loadScripts(context, names)`、`pageScripts(page): string[]`（按 HTML 里 `<script src>` 的顺序）、`plain(value)`、`flush()`。
  - `dom.cjs`：`createDom(options) → { $, document, element(selector), handlers }`。`handlers.get('<selector>:<event>')` 返回一个可直接调用的分发函数，依次执行该键上注册的全部回调，返回最后一个的结果；多事件名按空格拆分。
  - `chrome.cjs`：`createChrome({ sync, local, messages, onSyncSet }) → chrome`。`get` 只返回请求的键（字符串、数组、带默认值的对象、`null` 四种形式），读写都按 JSON 克隆；`sync` 与 `local` 传同一个对象即为合并存储；`onChanged` 只记录监听器，由测试调用 `emit` 触发。
  - `environments.cjs`：`harness`、`loadRules`、`runtime`、`loadApi`、`loadPopup`，名字、参数、返回对象的形状与现在各测试文件里的同名函数一致。

- [ ] **Step 1:** 先原样搬：把五个测试文件的桩函数移到 `environments.cjs`，测试文件改为 `require`。`npm test` — Expected: 100 通过。
- [ ] **Step 2:** 写 `scripts.cjs`、`dom.cjs`、`chrome.cjs`，让 `environments.cjs` 里的五个函数改用它们。`npm test` — Expected: 100 通过。若某条测试只有放宽断言才能通过，停下来报告，不要改断言。
- [ ] **Step 3: 机械比对：** 对五个测试文件，取出改动前后所有 `test(` 到文件末尾的文本，逐字比较 — Expected: 相同。
- [ ] **Step 4: 变异验证：** 把 `createChrome` 的 `get` 改成返回全部键 → 至少应不影响通过（记录结果）；把分发函数改成只执行第一个回调 → 记录哪些测试失败。还原。
- [ ] **Step 5:** `npm run check`。**Commit** `把四套测试桩抽到 tests/helpers，测试体不变`

### Task 5: 设置页与暂存文件的单元测试

**Files:**
- Create: `tests/helpers/indexeddb.cjs`、`tests/settings.test.cjs`、`tests/staged-files.test.cjs`
- Modify: `tests/helpers/environments.cjs`（新增 `loadSettings`、`loadStagedFiles`）

**Interfaces:**
- Produces: `createIndexedDB() → indexedDB`（内存实现：`open`、升级、对象仓库、事务、游标；回调异步触发；`get` 返回浅拷贝，`Blob` 保持引用）；`loadSettings(storage, responder)`、`loadStagedFiles(options)`。

这些是对现状的描述性测试，首次运行就应通过；每条写完后把对应产品代码临时改坏一次，确认测试会失败，再还原。

- [ ] **Step 1: `tests/settings.test.cjs`：**
  - 已保存的设置回填表单：地址显示、令牌输入框为空但带占位、状态行显示账号和服务器版本。
  - 验证成功：地址被规整（去空白、补结尾斜杠）并保存，令牌、用户信息、版本写入存储，令牌输入框清空。
  - 令牌留空、地址未变：沿用已保存的令牌。
  - 令牌留空、地址改了：**不得**把已保存的令牌发给新地址，状态为 `placeApiTokens`。
  - 401、非法地址（`javascript:alert(1)` 加令牌 → `invalidUrl`）、一般错误：不写存储，保存按钮恢复可用。
  - 实例资料读取失败：连接仍然保存。
  - 标签规则：`#私密，日记` 保存为不带 `#` 的两个标签并回写输入框。
- [ ] **Step 2: `tests/staged-files.test.cjs`：**
  - `stage`：图片得到 `![名称](memos-local://…)`，其他文件得到 `[名称](memos-local://…)`，名称里的方括号被转义。
  - `fromUrl`：拒绝非 http(s)、带凭据的地址、非 2xx、非图片类型；成功时请求不带凭据和来源页。
  - `resolve`：同一文件两处引用只上传一次，两处都替换成同一个地址；同一尝试 ID 重试不重复上传；新的尝试 ID 重新上传（固定现状，R3 会改它）。
  - 引用了不存在的暂存文件：在任何上传之前就失败。
  - `collect()`：超过 7 天且没有被当前草稿、AI 审阅、撤销记录、冲突副本引用的文件被删除，其余保留。
- [ ] **Step 3:** `npm run check`。**Commit** `补充设置页连接表单与暂存文件的单元测试`

### Task 6: 静态一致性测试，删除无引用词条

**Files:**
- Create: `tests/consistency.test.cjs`
- Modify: `tests/helpers/environments.cjs`（新增 `loadPage(page)`、`loadWorker()`）、三个 `_locales/*/messages.json`、`tests/current-release.test.cjs`（若有被取代的窄断言）

**Interfaces:**
- Produces: `loadPage(page) → { context, scripts }`：按 HTML 顺序在同一个桩环境里执行该页全部自有脚本，`$`、`ViewImage` 只在页面带了对应 `<script>` 时才提供；任一脚本同步抛错即以脚本名报错。`loadWorker()`：执行 `js/background.js`，`importScripts` 把所列文件加载进同一环境。

- [ ] **Step 1: 写测试：**
  - 三种语言键集合相同，`message` 非空，`{name}` 与 `{{name}}` 占位符在三种语言里一致。
  - 每个词条键都被引用：在自有运行时文件（`js/` 非第三方、三个 HTML）里作为整词出现，或在 `manifest.json` 里以 `__MSG_键__` 出现，或属于 `aiTask_*`、`aiTaskHelp_*` 两个动态拼接的族。
  - 反向：HTML 的 `data-i18n*` 属性和 JS 里 `uiMessage('…')`、`getLLMMessage('…')`、`chrome.i18n.getMessage('…')` 的字面量键都存在。（三元表达式和运行时拼出的键查不到，测试名里写明。）
  - `manifest.json` 版本 `A.B.C.D` 对应 `package.json` 的 `A.B.C-D`；`package-lock.json` 根版本与 `package.json` 相同。
  - HTML 引用的每个脚本和样式文件都存在，同一页内无重复。
  - `loadPage('popup.html')`、`loadPage('options.html')`、`loadPage('panel.html')`、`loadWorker()` 不抛错；之后每个已加载脚本 `/* global */` 里列的名字都必须在该环境里存在，缺失的（脚本，名字）集合必须**恰好等于**测试里写明的例外表。
- [ ] **Step 2:** Run — Expected: "每个词条键都被引用"失败，列出 20 条；其余通过。若例外表之外还有缺失，那是真问题，停下来报告。
- [ ] **Step 3:** 从三个语言文件删除这 20 条（清单见路线图 E7）。Run — Expected: 全部通过。
- [ ] **Step 4: 变异验证：** 从 `options.html` 删掉 `js/memo-tags.js` 那一行 → 测试失败；把 `popup.html` 里两个脚本对调成依赖方在前 → 测试失败；改掉一个语言文件里的占位符 → 测试失败。还原。
- [ ] **Step 5:** `npm run check`。**Commit** `新增静态一致性测试，删除 20 条无引用词条`

### Task 7: CI 与文档

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`（开发一节）、`tests/consistency.test.cjs`、`docs/superpowers/specs/2026-11-20-optimization-roadmap-design.md`（状态行与进度）

**Interfaces:**
- 工作流：`push` 与 `pull_request` 触发；`permissions: contents: read`；同一分支的旧运行自动取消。
  - `checks`（`ubuntu-latest`，Node 22）：`npm ci --ignore-scripts` → `npm run check` → `node scripts/vendor-clipper.cjs` 后 `git diff --exit-code`。
  - `package`（`windows-latest`，Node 24）：`npm ci --ignore-scripts` → `npm test` → `npm run package` → 上传 ZIP 与校验文件（保留 30 天，找不到文件即失败）。
  - Action 版本：`actions/checkout@v7`、`actions/setup-node@v7`、`actions/upload-artifact@v7`。

- [ ] **Step 1: 写测试：** 工作流里出现的每个 `npm run <名字>` 都在 `package.json` 的 `scripts` 里。Run — Expected: FAIL（文件不存在）。
- [ ] **Step 2:** 写工作流；`npm run format:check` 确认 YAML 能被解析且格式正确。
- [ ] **Step 3:** 本地逐条执行两个 job 的命令（打包输出到临时目录）— Expected: 全部成功，ZIP 的文件清单与本批开始前的基线相同。
- [ ] **Step 4:** README 开发一节：Node 版本、`npm run check` / `lint` / `format`、`tests/helpers/` 的用途。路线图文档：状态行改为"第 0 批、第 4 批前半已完成"，附提交范围。
- [ ] **Step 5:** 浏览器验收：先备份 `artifacts/` 里当前版本的目录，对打包产物跑 `scripts/check-chrome.cjs`（环境见记忆 `e2e-environment`），通过后恢复备份。
- [ ] **Step 6: Commit** `新增 GitHub Actions 工作流，更新开发说明与路线图进度`
