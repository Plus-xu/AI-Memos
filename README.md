# AI-MEMOS

带 AI 优化功能的 Chrome Memos 扩展。当前扩展版本为 **2026.11.12.1**，基于 `codex/newfeatures`，以 **Memos 26.11.0** 为兼容目标。此前用户验证通过的兼容版保留在标签 `v2026.11.12`。

## AI 审阅、任务预设与选区剪藏

- 在编辑器上方选择“整理格式 / 摘要 / 提取要点 / 生成问答”，再点击 AI 按钮。原文保持不变，处理结果显示在独立的对比面板中，可先编辑结果，再选择采用、追加或取消。
- 采用或追加后可用“撤销 AI”还原。若等待期间修改了原文，“采用结果”会禁用；若采用后又修改正文，撤销也不会覆盖新内容。待确认结果和最近一次撤销记录保存在本地，重开弹窗可以恢复；AI 请求进行中关闭弹窗不会让请求继续在后台运行，原草稿仍在。
- 系统会检查结果是否缺少原有来源链接或图片地址并给出提醒；该检查不能替代事实核对。
- 设置中的三个快捷预设可以分别指定名称、任务、模型及自定义提示词。旧模型预设继续有效，默认执行“整理格式”。新增任务配置保存在本地，旧同步记录只保留兼容的提供商与模型字段；连接和模型密钥的存储方式没有在本轮迁移。
- 在网页选中文字后，右键选择“摘录选区并附来源”。选文按多行引用保存，并附上标题、原链接和 ISO 8601 UTC 采集时间；再次采集会追加到原草稿。多次快速采集按队列处理。
- 弹窗中的“添加来源”只追加当前网页的标题、链接和时间，不读取网页正文。选区剪藏使用现有右键菜单能力，没有增加 Chrome 权限。
- 设置中可修改剪藏模板，支持 `{{content}}`、`{{title}}`、`{{url}}`、`{{date}}`；内容和来源占位符必须保留。模板失效时右键采集回退默认模板，不会写入空选文。

本轮范围是上述三项优先功能。全文提取、侧栏、剪藏历史去重、Space/Views 控件、待发送箱与外部笔记同步尚未加入。

## 打包与本地预览

```powershell
npm.cmd run package
npm.cmd run preview
```

打包需要 PowerShell 7，输出 `artifacts/ai-memos-<扩展版本>.zip` 及 `.zip.sha256`。仅包含运行文件，排除浏览器商店签名元数据、测试、预览工具及开发文档；打包时验证资源路径并逐文件核对 ZIP 内容。

预览地址为 `http://127.0.0.1:4311/popup.html`，仅使用公开的虚拟配置与模拟服务，外网访问受 CSP 阻止，不读取或修改 Chrome 扩展配置，也不连接真实 Memos 或 AI。此页面用于开发验证，不是部署版本。

## 本次兼容更新

- 优先使用 `/api/...`。旧服务器返回 404 或 HTML 页面时尝试 `/api/v1/...`，缓存每个实例使用的路径；升级后遇到 410 会重新探测。认证失败、配额限制、超时和服务器错误不会自动重发写请求。
- 保存连接时检查当前用户和 PAT，并尝试读取服务器版本。版本读取失败不影响已通过认证的连接。
- 标签、搜索和随机回顾读取完整分页，保留筛选条件和不透明的 `nextPageToken`，避免只处理前 50 或 1000 条。搜索及回顾覆盖当前账号有权读取的笔记，包括 PRIVATE 和 SPACE。
- 创建 Memo 前解析草稿中的本实例附件引用，查询附件状态并提交 `attachments`。正文图片改为服务端要求的相对路径；指向其他 Memo 已绑定文件的普通链接保留引用。
- 附件文件名进行 URL 编码。私密图片通过携带 Bearer 头的请求读取，再使用临时 Blob URL 展示；私密文件链接通过同样的方式下载。凭据不会放进文件 URL，也不会随附件请求发给外站或跟随重定向。
- 保存过程中阻止重复提交，等候进行中的上传。上传或保存失败保留草稿，服务器拒绝请求时区分权限、配额、频率限制和超时。
- 草稿使用 `chrome.storage.local`，避开同步存储的单项 8 KiB 限制；首次使用时兼容读取旧同步草稿。输入、工具栏插入、AI 优化结果和右键采集共用草稿。草稿不再跨设备同步，连接和 AI 设置仍沿用原来的存储方式。

## 在 Chrome 中使用

1. 打开 `chrome://extensions/` 并启用开发者模式。
2. 选择“加载已解压的扩展程序”，指向本项目目录；更新已加载的同一目录后，点击扩展卡片上的重新加载。
3. 填入 Memos 主页网址和个人访问令牌（PAT），点击保存。26.11.0 服务器使用 `/api`，网址栏仍填写主页地址。

现有 Chrome 使用的独立副本不会随项目目录修改而更新。若继续使用独立副本，需要同步更新全部运行文件，包括新增的 `js/draft-storage.js`，然后重新加载扩展。

## 验证

需要 Node.js 22.8 或更新版本，无需安装第三方依赖。在项目目录运行：

```powershell
npm.cmd test
node --check js/memos-api.js
node --check js/oper.js
node --check js/draft-storage.js
node --check js/background.js
node --check js/ai-optimize.js
git diff --check
```

自动测试使用官方接口契约的模拟响应和弹窗事件环境，覆盖新旧路径切换、分页、附件绑定与鉴权、草稿迁移和失败重试，不会连接或修改真实 Memos。

真实实例联调时检查：

1. 用 PAT 保存连接，确认成功提示中的服务器版本。
2. 粘贴或上传一张图片，关闭并重开弹窗，确认草稿仍在；保存为私密 Memo 后检查图片预览、附件关联和文件下载。
3. 用包含引号、反斜杠的文本搜索，确认自己可访问的私密和 Space 笔记能找到。
4. 检查标签列表、随机回顾和归档。查看服务器中归档结果是否与弹窗一致。

## 接口依据

- [Memos 26.10.0 API 迁移说明](https://github.com/usememos/memos/releases/tag/26.10.0)
- [Memos 26.11.0 Memo 接口](https://github.com/usememos/memos/blob/26.11.0/proto/api/memo_service.proto)
- [Memos 26.11.0 附件校验](https://github.com/usememos/memos/blob/26.11.0/server/api/memo_attachment_service.go)
- [官方 Web Clipper 请求层参考](https://github.com/usememos/web-clipper/blob/5f9c8ab07172bcb58b0b609dedd8211de88feb08/src/lib/memos-client.ts)
- [Chrome storage 配额](https://developer.chrome.com/docs/extensions/reference/api/storage#property-sync-QUOTA_BYTES_PER_ITEM)
