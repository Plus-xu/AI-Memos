# AI-MEMOS

在 Chrome 中速记、剪藏网页，并用 AI 整理 Memos 笔记。扩展适配 Memos 26.11.1，支持仍使用 `/api/v1` 的旧实例。剪藏流程参考官方 Memos Web Clipper 0.6.1。[修改记录](CHANGELOG.md) · [Memos 发行说明](https://github.com/usememos/memos/releases/tag/26.11.1) · [官方 Chrome 扩展](https://chromewebstore.google.com/detail/memos-web-clipper/nebaoebnljalfegiidibihhkebeiklbl)

## 开始使用

1. 解压发布包，在 Chrome 扩展程序页启用开发者模式，选择「加载已解压的扩展程序」并选中解压目录。更新时覆盖原目录，再点击扩展卡片上的重新加载。
2. 点击 AI-MEMOS 图标即可写草稿。第一次保存笔记前，打开右上角设置，填入 Memos 主页地址和个人访问令牌，点击「验证并保存连接」。连接成功后会显示账号和可读取的服务器版本。
3. 输入正文或点击「剪藏网页」，选择空间和可见范围，点击「保存到 Memos」。也可按 `Ctrl+Enter`，macOS 使用 `⌘+Enter`。读长文时点击「在侧栏打开」，可边看原网页边续写。
4. 需要 AI 时，在设置中选择提供商、填写 API 密钥并保存。New API 还需要填写网关地址。在编辑器中运行 AI，审阅结果后可采用、追加，或保留原稿。

## 记录与剪藏

| 操作 | 结果 |
| --- | --- |
| 剪藏网页 | 优先读取选区；无选区时提取正文，保留 Markdown 标题、链接、列表、代码和表格。正文不足时使用网页简介或标题，并附上来源。每次剪藏最多保存 30 张图片、合计 60 MB，超出的保留为指向原地址的图片链接，并提示核对草稿。 |
| 右键剪藏 | 网页选区、图片或链接都追加到当前草稿。点击保存才会向 Memos 创建笔记。浏览器内部页面和扩展商店页面可能不支持读取。 |
| 仅插入来源 | 展开剪藏按钮旁的菜单，在光标或选区位置插入当前页链接。可为这次操作开启采集时间。 |
| 添加附件 | 支持粘贴截图、拖放和选择文件。图片与文件先存入本机 IndexedDB，保存时上传，并把附件与笔记绑定。单个文件超过实例的上传上限（读不到时按 30 MB）会在加入草稿时被拒绝并提示。上传失败可从当前草稿重试。 |
| 修改草稿 | 弹窗、侧栏与右键共用本机草稿。不同位置的改动会自动合并；同一位置发生冲突时可保留两份或采用已保存版本。 |
| 空间和可见范围 | 支持空间的账号可选择保存位置。选择空间后可使用「空间成员」范围。保存前会显示标签规则的实际影响；空间失效时保留草稿，等你重新选择。 |
| 查找与回顾 | 「查找」按关键词和标签请求服务端，可加载下一页、随机回顾或归档自己的笔记。标签列表优先读取账号的标签统计，此时只列出本人未归档笔记的标签；随机回顾从最多 20000 条笔记里抽取，每次只取一条。两者所需的索引按账号缓存 10 分钟：保存后新标签和新笔记立即可用，归档后的标签在下次展开时重新核对。「剪藏历史」按实例和账号保存最近 300 条来源记录，支持打开原网页或笔记。 |
| 自定义剪藏模板 | 支持 `{{content}}`、`{{title}}`、`{{url}}` 和 `{{date}}`。模板必须保留内容和网址；删除日期占位符即可省略模板里的时间。 |

扩展支持简体中文、英语、日语，以及浅色、深色和跟随系统。首次打开沿用浏览器语言，旧有连接、模型选择、快捷预设和草稿可继续使用。

## AI 模型与审阅

2026 年 11 月 19 日核对的内置文本模型如下。设置中的「刷新可用模型」读取当前凭据对应的目录，主模型和三个快捷预设共用候选列表。你也可以手动输入模型 ID。推理访问权限由服务商或网关决定。

| 服务 | 新配置的默认项 | 其他内置选项 |
| --- | --- | --- |
| OpenAI | `gpt-6.2-sol` | `gpt-6.2-astra`、`gpt-6.1-terra`、`gpt-6-luna`。[模型目录](https://developers.openai.com/api/docs/models) |
| Anthropic | `claude-sonnet-5-5` | `claude-haiku-5-5`、`claude-opus-5-5`、`claude-fable-5-2`。[模型目录](https://platform.claude.com/docs/en/models/overview) |
| Gemini | `gemini-4-hydrogen` | `gemini-4-neon`、`gemini-4-argon`、`gemini-4-carbon`、`gemini-3.5-flash-lite`。[模型目录](https://aistudio.google.com/docs/models) |
| DeepSeek | `deepseek-flash` | `deepseek-v4-pro`。旧配置可继续使用 `deepseek-v4-flash` 兼容别名。[模型说明](https://api-docs.deepseek.com/quick_start/pricing/) |
| New API | 选择网关返回的模型，或填写 ID | 使用网关的 `/v1/models` 和 Chat Completions 接口。[模型列表接口](https://docs.newapi.ai/zh/docs/api/ai-model/models/list/listmodels) |

「AI」主按钮显示当前任务。展开菜单可切换整理格式、摘要、提取要点和生成问答，也可运行单独配置了模型、任务和提示词的快捷预设。生成的文字边生成边显示在审阅区，生成中可以点「停止」；停止或连接中途断开时，已生成的部分保留下来供审阅，并标明不完整。模型或网关不支持流式输出时，结果在生成结束后一次显示。生成结果可编辑，缺少来源或图片引用时会提示。采用结果后可以撤销；等待时若改过原稿，可将结果追加到最新稿件。关闭生成窗口后，可重开并从原稿重试。

设置中的「AI 输出语言」决定结果用哪种语言：

- **自动**（默认）：整理格式保持原文语言，不翻译；摘要、提取要点和生成问答使用界面语言。自定义提示词的输出语言由提示词决定。
- **始终使用界面语言**：所有任务都用界面语言输出，外文笔记会被翻译。自定义提示词写明了语言时以提示词为准。
- **始终保持原文语言**：所有任务都用笔记本身的语言输出。自定义提示词写明了语言时以提示词为准。

## 本机数据与权限

- 正文草稿、待审 AI 结果、撤销记录、剪藏历史和图片暂存于当前浏览器配置。历史仅保存标题、来源网址、笔记资源名和保存时间。空间列表和旧实例的接口前缀也记在本机，用于打开时先显示、后台再核对；标签与笔记资源名的索引只保存在浏览器会话中，关闭浏览器即清除。
- Memos 个人访问令牌、模型凭据和连接设置沿用扩展原有的 Chrome 同步存储。模型目录按提供商、接口地址和凭据隔离缓存。点击 AI 任务时，正文会发送至所选服务。
- `scripting` 用于在用户发起剪藏时从目标标签页或选中框架提取内容，`sidePanel` 用于打开侧栏。正文解析库随安装包提供。HTTP/HTTPS 站点权限用于访问用户指定的网页、Memos 实例和模型服务。[Chrome 脚本 API](https://developer.chrome.com/docs/extensions/reference/api/scripting) · [Chrome 侧栏 API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- 服务端笔记搜索与权限由 Memos 决定。受保护附件按实例认证读取，现代实例通过客户端笔记 ID 确认重试，旧实例按其支持的接口保存。[Memos API](https://usememos.com/docs/integrations/api-access) · [Space 与可见性](https://usememos.com/docs/usage/spaces)

## 开发与验收

需要 Node.js 24 或以上。打包使用 PowerShell 7。首次克隆后可运行 `git config blame.ignoreRevsFile .git-blame-ignore-revs`，让 `git blame` 跳过纯格式化提交。

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd run preview
npm.cmd run package
```

`npm.cmd run check` 依次执行格式检查（`format:check`）、代码检查（`lint`）和单元测试（`test`），提交前跑这一条即可；`npm.cmd run format` 按 Prettier 规则改写文件。单元测试只用 Node 内置模块，不安装依赖也能运行 `npm.cmd test`。每次推送和拉取请求，GitHub Actions（`.github/workflows/ci.yml`）会执行同样的检查并打包。

各脚本用到的其他文件里的名字，写在文件顶部的 `/* global */` 注释里；新增页面脚本或调整 `<script>` 顺序后，`tests/consistency.test.cjs` 会核对每个页面是否加载了这些名字，以及三种语言的词条是否一致、是否都有引用。`tests/helpers/` 放测试共用的替身：页面与 jQuery（`dom.cjs`）、`chrome.*`（`chrome.cjs`）、IndexedDB（`indexeddb.cjs`），以及在这些替身上加载真实脚本的现成环境（`environments.cjs`）。替身自身的行为由 `tests/helpers.test.cjs` 固定。

预览地址由终端输出。预览使用本机模拟数据，可测试记录、查找、设置及 AI 审阅。ZIP 和 SHA-256 校验文件生成在 `artifacts/`。要从锁文件重新生成正文解析依赖，运行 `npm.cmd ci --ignore-scripts` 和 `node scripts/vendor-clipper.cjs`。

浏览器验收脚本 `scripts/check-chrome.cjs` 使用临时配置及回环地址上的 Memos、New API 测试服务。先解压待验收的 ZIP，设置 `EXTENSION_PATH` 为该目录、`CHROMIUM_PATH` 为支持扩展的 Chromium 可执行文件。如果环境中没有可直接导入的 `playwright-core`，将 `PLAYWRIGHT_MODULE` 指向它的安装目录。运行 `node scripts/check-chrome.cjs` 后，截图和检查结果保存在 `artifacts/acceptance-<版本>/`。

如需实测 Memos 26.11.1，可另外将 `MEMOS_BINARY` 指向从官方发行包解压的可执行文件。脚本默认要求该程序为 26.11.1；用其他版本实测时，将 `MEMOS_VERSION` 设为该版本号。脚本会启动仅监听本机的临时 SQLite 实例，创建测试账号和临时令牌，从扩展界面保存、搜索、预览并归档测试笔记，随后关闭实例并清理测试库。[官方发行包及校验值](https://github.com/usememos/memos/releases/expanded_assets/26.11.1)

### 试装与升版

临时试装运行 `npm.cmd run package:dev`。ZIP 文件名和 Chrome 显示版本都包含当前 Git 短提交号和运行文件的摘要，同一提交上的本地改动也能区分。解压后可用临时 Chrome 配置加载测试包。

将一批改动交付到常用 Chrome 目录前，把变更记入「未发布」，再指定一个 `年.月.日.序号` 版本。月、日不补零，每天从 `1` 开始，同日交付依次加一。升版命令同步 `manifest.json`、`package.json`、`package-lock.json`，并为这一批日志建立版本标题。以当天首次交付为例：

```powershell
npm.cmd run version:bump -- 2026.11.27.1
npm.cmd run check
npm.cmd run package
```

通过浏览器验收后，用相应的 Git 标签（例如 `v2026.11.27.1`）标记这份 ZIP 的源提交，保留 ZIP 与 SHA-256，供安装和回滚使用。
