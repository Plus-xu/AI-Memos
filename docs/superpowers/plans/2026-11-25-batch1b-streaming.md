# 第 1 批后半：AI 流式输出与停止（A4 第一阶段） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 生成的文字边到边显示在审阅面板，生成中可以点「停止」并保留已收到的部分；超时改为"一段时间没有新内容"才算。

**Architecture:** `js/http.js` 增加一个边收边读的请求 `Http.stream`，负责事件流的切分、静默超时和调用方的中止。四种接口的请求构造、事件解读和文本提取从 `js/ai-optimize.js` 搬到新文件 `js/llm-transport.js`（路线图 S1 的一部分），它不碰页面元素，也不读设置。`js/ai-optimize.js` 的 `callLLMAPI` 只剩拼提示词、调用传输、把失败换成提示文字。审阅面板多一个不落盘的"生成中"状态，结束时换成正式的待审结果。

**Tech Stack:** 原生脚本、`fetch` 的 `ReadableStream`、`AbortController`、`node --test`。

**Spec:** `docs/superpowers/specs/2026-11-20-optimization-roadmap-design.md` 第 7 节第 1 批的 A4（只做第一阶段）、第 5 批 S1 表格里的 `js/llm-transport.js`、第 9 节"流式解析的实现细节，以及每家服务商截断信号的字段名"。第二阶段（请求移到 Service Worker）按第 8 节第 3 项的默认不做。

## Global Constraints

- 不引入打包器、TypeScript、框架，不加依赖。
- 四种接口都发流式请求：OpenAI Responses、Chat Completions、Anthropic 在请求体里加 `"stream": true`；Gemini 的地址由 `:generateContent` 换成 `:streamGenerateContent?alt=sse`，请求体不变。
- 服务器没有按事件流回答（`Content-Type` 不是 `text/event-stream`）时，按原来的整段 JSON 处理，结果与改动前一致。有的网关不支持流式，这条路必须保留。
- 静默超时 90 秒：从发出请求到收到响应头、以及相邻两段数据之间，超过 90 秒没有任何字节才算超时。服务商的心跳（如 Anthropic 的 `ping`）算作有数据。
- 请求仍带 `credentials: 'same-origin'` 和 `Content-Type: application/json`，`Accept` 为 `text/event-stream, application/json`。
- 生成中的文字只在发起生成的那个编辑器里显示，不写存储。另一个编辑器照旧只显示"正在执行"。「停止」按钮也只出现在发起的那个编辑器里。
- 停止、连接中断、超时这三种情况，只要已经收到可见文字，就保留下来进入审阅，并标明不完整；一个字都没收到时不进入审阅，只提示。草稿在任何情况下都不变。
- 待审结果的 `truncated` 字段：到达输出上限仍是 `true`（旧数据兼容），手动停止为 `'stopped'`，连接中断或超时为 `'interrupted'`，服务商提前结束为 `'ended'`（第三轮评审后加的）。
- 新增词条四个，三种语言都要有，文字是定稿：

  | 键 | 中文 | English | 日本語 |
  | --- | --- | --- | --- |
  | `aiStop` | 停止 | Stop | 停止 |
  | `aiStopped` | 已停止生成，草稿未改动。 | Generation stopped. Your draft is unchanged. | 生成を停止しました。下書きは変更されていません。 |
  | `aiStoppedWarning` | 生成已手动停止，结果不完整。 | Generation was stopped, so the result is incomplete. | 生成を停止したため、結果は不完全です。 |
  | `aiInterruptedWarning` | 连接在生成途中中断，结果不完整，可以重试。 | The connection dropped during generation, so the result is incomplete. You can retry. | 生成中に接続が切れたため、結果は不完全です。再試行できます。 |

- `npm run check` 每个任务结束时通过。只做本地提交，不推送、不改版本号。
- 不覆盖 `artifacts/` 里已有的验收记录（跑验收脚本前备份、跑完还原）。

## 各接口的流式格式（实现时照此解读）

| 接口 | 文字增量 | 结束与截断 | 流内错误 |
| --- | --- | --- | --- |
| OpenAI Responses | `type: response.output_text.delta` 的 `delta` | `response.completed` / `response.incomplete` / `response.failed`，带完整的 `response`；`response.status === 'incomplete'` 为截断。这个 `response` 里按原来的办法取得到全文时，以它为准（第六轮评审后改的：原先只在一个增量都没收到时才取，网关只转发了一部分增量、或某个增量损坏时，完成事件带的全文被丢掉；现在取到全文就不再算缺了一段） | `type: error` 的 `message`；`response.failed` 的 `response.error.message` |
| Chat Completions | `choices[0].delta.content`（字符串，或 `{type:'text',text}` 的数组）；`reasoning_content` 不算 | `choices[0].finish_reason` 非空，或 `data: [DONE]`；`length` 为截断 | `error.message` |
| Gemini | 每个事件是一个 `GenerateContentResponse`，取 `candidates[0].content.parts[].text`，`thought` 为真的不算 | `candidates[0].finishReason` 非空；`MAX_TOKENS`、`CONTINUATION` 为截断 | `error.message` |
| Anthropic | `content_block_delta` 且 `delta.type === 'text_delta'` 的 `delta.text` | `message_delta` 的 `delta.stop_reason` 或 `message_stop`；`max_tokens` 为截断 | `type: error` 的 `error.message` |

事件流正常结束却没出现过上表的"结束"信号，按连接中断处理。不是 JSON 的 `data`（如 `[DONE]` 之外的杂项）跳过。

（实施时定下的两点：`data: [DONE]` 对四种接口都算结束信号，不只是 Chat Completions；已经出现过结束信号的回答算完整，此后连接断开或用户点停止都不改变结果。）

（第二轮评审后改的两点。其一，结束原因分三类：上表的截断原因仍是截断；`stop`、`end_turn`、`stop_sequence`、`STOP`、`completed` 和没给原因算完整；其余原因不论认不认识（如 `content_filter`、`insufficient_system_resource`、`SAFETY`、`refusal`）都算服务商提前结束，有文字时按 `'ended'` 进入审阅（第三轮评审后改的：原来记作 `'interrupted'`，内容过滤会被提示成连接中断；现在有自己的词条 `aiEndedWarning`：生成提前结束，结果不完整。 / Generation ended early, so the result is incomplete. / 生成が途中で終了したため、結果は不完全です。），没有文字时与改动前一样按空回答提示。OpenAI 的 `incomplete` 再看 `incomplete_details.reason`：`max_output_tokens` 或没给时是截断，其余同上。整段回答也按这个规则。其二，收到结束信号就结算并中止请求，不再等服务器关闭连接：有的网关在结束后还发心跳，原来会一直显示"生成中"。）

## Review Focus

1. 一个多字节字符、一行、或一对 `\r\n` 被拆在两段数据里：解出的文字与一次收全时相同。（Task 1）
2. 网关不支持流式，用整段 JSON 回答流式请求：结果照常进入审阅。网关把事件流标成了别的 `Content-Type`：正文不是 JSON 而以 `data:` / `event:` / `:` 开头时仍按事件流解读。（Task 1、Task 2。评审后补上反过来的情况：标成事件流的整段 JSON 按整段读；直接拒绝流式请求的服务器改用整段请求重试一次。）
3. 事件流中途断开、或干净地结束但没有结束信号：已收到的文字进入审阅并标明不完整，不当作完整结果。（Task 2）
4. 有生成中的文字在显示时，再点一次 AI、点「采用」「追加」「取消结果」、或直接编辑结果框：都不起作用，结果框只读；结束后恢复可编辑。（Task 3。评审后改的措辞：第一段文字到达之前，原来那条待审结果照旧可以编辑和取消，与改动前一致；这时再点 AI、「采用」「追加」同样不起作用。）
5. 面板里本来有一条待审结果，新的生成一个字都没收到就失败或被停止：原来那条待审结果还在，内容不变。（Task 3）

---

### Task 1: `Http.stream`，边收边读的请求

**Files:**
- Modify: `js/http.js`
- Modify: `tests/helpers/http.cjs`（新增 `streamingFetch`）、`tests/helpers.test.cjs`（它的契约测试）
- Test: `tests/http.test.cjs`

**Interfaces（Produces）:**
- `Http.stream({ url, method = 'POST', headers = {}, body, idle = 90000, signal, onEvent }) → Promise<{ streamed: true } | { streamed: false, data }>`
  - 事件流：每个事件调用一次 `onEvent(data, name)`，`data` 是该事件各 `data:` 行以 `\n` 相连的文字，`name` 是 `event:` 的值，缺省为 `'message'`。注释行（以 `:` 开头）和没有 `data` 的事件不调用。流结束时缓冲里还有未以空行收尾的事件，也发出去。
  - 其他回答：读完整段后按 `Http.json` 的规则解析并返回 `{ streamed: false, data }`；状态码不是 2xx 时抛出与 `Http.json` 相同形状的失败对象。正文以 `data:` / `event:` / `id:` / `retry:` / `:` 开头时（JSON 不会这样开头），从头就按事件流边收边发出，返回 `{ streamed: true }`（实施时改的：原计划是读完整段再解读，那样静默超时管不到这种流，用户点停止时也留不下已收到的部分）。没有正文可读的回答（如 204）返回 `{ streamed: false }`；状态码不是 2xx 的回答即使标成或长得像事件流，也按拒绝处理。标成 `text/event-stream` 的回答，正文以 `{` 或 `[` 开头时按整段 JSON 读（评审后补上：事件流不会这样开头）。
  - （第四轮评审后补上）可选的 `afterPiece()`：一次到达的一段正文里的事件全部发出之后调用一次，流结束时最后一个事件发出之后也调用。
  - 失败对象的 `statusText`：静默超时为 `'timeout'`，调用方中止为 `'abort'`，其余网络错误为 `'error'`，`status` 都是 0。读到一半失败也是这样抛出，已经发出的事件不撤回。
  - `onEvent` 里抛出的异常原样向外抛，不包成失败对象。
  - （第二轮评审后补上）`onEvent` 返回 `true` 表示这个事件结束了回答：之后的事件不再发出，立即返回 `{ streamed: true }` 并中止请求。状态码不是 2xx 的失败对象多一个 `responseText`，是正文原文，正文不是 JSON 时也在。
- `tests/helpers/http.cjs` 的 `streamingFetch(requests)`：每个请求推入 `requests`，带 `send(text)`、`end()`、`fail(error)`，回答是一个真实的 `Response`，`Content-Type: text/event-stream`；请求的 `signal` 中止时，正文以 `AbortError` 出错。

- [ ] **Step 1: 写失败的测试**（`tests/http.test.cjs`，`loadHttp` 的上下文补上 `AbortController`、`TextDecoder`、`setTimeout`、`clearTimeout`）
  - `'an event stream is delivered one event at a time, with its name'`：正文 `event: a\ndata: 1\n\n: comment\n\ndata: 2\ndata: 3\n\n`，收到 `[['1','a'],['2\n3','message']]`，结果 `{ streamed: true }`。
  - `'events split across chunks, lines, CRLF pairs and multi-byte characters are put back together'`：把 `event: a\r\ndata: 你好\r\ndata: b\r\n\r\ndata: c\r\n\r\n` 的字节在每个位置切成两段各试一次，每次都收到 `[['你好\nb','a'],['c','message']]`（实施时换的正文：原来只有单行事件，一对 `\r\n` 被拆开时多出的空行不改变结果，去掉这段处理测试也通过）。
  - `'an event without its closing blank line is still delivered when the stream ends'`。
  - `'an answer that is not an event stream is parsed as JSON, and a refusal fails as json() does'`：`application/json` 的 200 得到 `{ streamed: false, data }`；400 带 JSON 正文抛出 `status === 400` 且 `responseJSON` 在。
  - `'an event stream under another content type is still read as events, as they arrive'`：`text/plain` 和 `application/json` 各一条，事件在流结束之前就已发出。
  - `'a streamed request declares both answer types and carries the same cookies and JSON body as json()'`：`Accept`、`Content-Type`、`credentials`、`body`。
  - `'silence longer than the idle limit is a timeout, while a slow stream that keeps sending is not'`：用测试自己拨动的时钟：每 60 秒一段共 6 段成功，标成 `text/plain` 的流也一样；不指定 `idle` 时，最后一段之后 89999 毫秒还在等，满 90000 毫秒失败且 `statusText === 'timeout'`（评审后改的：原来用真实定时器，CPU 超订时会误报；现在不依赖机器快慢，并钉住默认的 90 秒）。
  - `'stopping through the caller\'s signal fails with "abort", before the answer and in the middle of it'`。
  - `'an error thrown by onEvent is not turned into a request failure'`。
- [ ] **Step 2: 运行 `node --test tests/http.test.cjs`，新用例失败（`http.stream is not a function`）**
- [ ] **Step 3: 实现**。静默计时用一个定时器：记下最后一次收到数据的时刻，定时器到点时若距那一刻不足 `idle` 就按剩余时间重新定时，否则中止请求；结束时清掉定时器并解除对 `signal` 的监听。`json()` 里"解析正文、按状态码决定成败"的部分抽成两者共用的函数。
- [ ] **Step 4: 运行 `npm run check`，全部通过**
- [ ] **Step 5: 提交** `git commit -m "Http.stream：边收边读的请求，按事件切分，静默 90 秒才算超时，可由调用方中止"`

### Task 2: `js/llm-transport.js`，四种接口改为流式

**Files:**
- Create: `js/llm-transport.js`
- Modify: `js/ai-optimize.js`（删去搬走的函数，改写 `callLLMAPI` 与 `extractLLMErrorMessage`）、`_locales/{zh_CN,en,ja}/messages.json`（只加 `aiStopped`：`callLLMAPI` 用到它，而一致性测试要求用到的词条都存在；实施时从 Task 3 提前）、`popup.html`（在 `js/ai-optimize.js` 之前加载新脚本）、`tests/helpers/environments.cjs`（`harness`、`runtime` 加载新脚本并补上所需的全局名）、`tests/consistency.test.cjs`（设置页不加载新脚本，记入 `absent`）、`scripts/preview-server.cjs`（识别 `:streamGenerateContent`）
- Test: 新建 `tests/llm-transport.test.cjs`；改 `tests/current-release.test.cjs`

**Interfaces:**
- Consumes: `Http.stream`（Task 1）。
- Produces:
  - `LLMTransport.request(providerConfig, { model, apiKey, system, user, maxTokens, apiUrl }) → { url, headers, body }`。`maxTokens` 为 0 时 Chat Completions 不带 `max_tokens`（New API 留空的现状）；`apiUrl` 覆盖 `providerConfig.apiUrl`（New API 的网关地址由调用方算好传入）。未知的 `endpointType` 抛出 `Error`。
  - `LLMTransport.generate(endpointType, request, { signal, onText, idle } = {}) → Promise<{ text, truncated, interrupted? }>`
    - `onText(text)`：每当可见文字变长时调用，参数是到目前为止的全文。（第四轮评审后改的：一起到达的事件只调用一次，不再每个事件一次。代理把几千个事件攒成一批送来时，原来每个事件都要对全文做一遍标记处理，三万个事件要 7 秒，页面在这期间不响应。）
    - 正常结束：`{ text, truncated }`，`text` 可以是空串（由调用方决定怎么提示）。
    - 停止、超时、网络错误、流内错误事件、缺少结束信号：已有非空白文字时返回 `{ text, truncated: true, interrupted }`，`interrupted` 为 `'stopped'`（调用方中止）或 `'interrupted'`（其余）；没有文字时抛出失败对象。流内错误和缺少结束信号的失败对象是 `{ status: 0, statusText: 'stream', reason }`，`reason` 是服务商给的原因，可能为空串。
    - （评审后补上）服务器以 400 或 422 拒绝请求、原因里提到 stream 时，去掉请求体里的 `stream` 再发一次，只重试一次（第二轮评审后改的：原因是纯文本时也认；stream 必须是一个词的开头，`upstream_error` 不算。第三轮评审后再改：JSON 错误只看原因字段 `error`、`error.message`、`error.param`、`error.code`、`message`、`detail`、`msg`，错误里回显的原请求不看；「流式」和 `SSE` 也认；重发的请求 `Accept` 只写 `application/json`，为此 `Http.stream` 多一个可选的 `accept`。第四轮评审后又改：只看那几个原因字段会漏掉 FastAPI 的 `detail[].loc`、`errors[]`、以字段名为键的错误、嵌套的 `metadata.raw`、`error.type` 等写法，所以改为读整个错误里的所有字符串和字段名；为了不被回显的原请求骗到，先去掉本次请求自己发出的、提到 stream 的文字（如笔记正文），值为 `true` 的 `stream` 字段不算，纯文本里 `{` 或 `,` 之后的 `"stream": true`、`'stream': True` 也不算；`server-sent` 也认。判断错的代价不对称：多发一次只是再被同样拒绝一次，漏判则这个模型完全用不了。第五轮评审后再改：只要提到 stream 就算拒绝会误判，上下文超长的 400 把请求叫作 stream request 时也多发一次，所以改为两种情况才算——某个字段整个就是一个提到 stream 的名字（`stream`、`body.stream`、`stream_not_supported`、`unsupported_stream`），或者同一句话里既提到流式、又有明确的拒绝措辞（not supported、unavailable、disabled、unknown、must be false、不支持、未开启等）；HTTP 406 按状态码直接算拒绝，不看正文，因为重发的请求 `Accept` 只写 `application/json`）。第六轮评审后再改：Gemini 的流式不在请求体里而在地址里，被拒绝时把地址末尾的 `:streamGenerateContent?alt=sse` 换回 `:generateContent` 再发一次，用户自填的地址不是这个结尾时没有别的办法、不重试；各接口怎么换成整段请求写在各自的 `plain()` 里。拒绝措辞补上要求关闭流式的说法：set stream to false、stream=false、should be false、disable / turn off streaming、without streaming、请关闭流式、非流式、设置为 false 等。Chat Completions 的事件里没有 `delta` 而有 `message` 时取 `message.content`（有的网关把整段回答当成一个事件发）。Gemini 的事件只有 `promptFeedback.blockReason`、没有候选时算结束，文字为空，提示与改动前一样是"没有返回可用的文本"。
  - `callLLMAPI(provider, model, apiKey, userContent, userLanguage, baseUrl, task, customPrompt, { signal, onText } = {})`：结果在原来的 `{ text, truncated }` 之外，被打断时多一个 `interrupted`。`onText` 收到的是已按 `AIWorkflow.unwrapNote(text, userContent, true)` 去掉回显标记的文字，只在要显示的文字有变化时调用（实施时补上：只收到回显标记时不调用，免得面板空着打开。第四轮评审后补上：标记只到了一半（`<`、`<no`、`<note>` 后只有 ``）或开头只有空行时也不调用，这时点停止算"一个字都没收到"，原来那条待审结果不动；回显的开头标记之后，末行是收到一半的结束标记（`</no`）时一并去掉。这两条规则写在 `AIWorkflow.unwrapNote` 里，只对不完整的回答生效）。整段回答不经过 `onText`。不是请求失败的错误（如 `onText` 自己抛出的）原样拒绝，不换成"请求中断"。被停止且没有文字时，拒绝的 `Error` 带 `stopped: true`，文字是 `aiStopped`。
  - `extractLLMErrorMessage(failure)`：`statusText === 'stream'` 时为 `aiInterrupted` 的文字，`reason` 非空则在后面加 `' (' + reason 的前 240 个字符 + ')'`；其余不变。

- [ ] **Step 1: 写失败的测试**（`tests/llm-transport.test.cjs`，用 `runtime()` 和 `streamingFetch`）
  - 四种接口各一条 `'<provider> streams text as it arrives and reports a normal end'`：把下面的事件逐个送入，`onText` 依次收到 `'Hel'`、`'Hello'`，结果 `{ text: 'Hello', truncated: false }`，并断言请求体或地址带了流式标志。
    - OpenAI：`response.created`、两个 `response.output_text.delta`、`response.completed`（`response.status: 'completed'`）。
    - DeepSeek：首块 `delta: { role, content: '' }`，一块只有 `reasoning_content`，两块 `content`，末块 `finish_reason: 'stop'`，然后 `[DONE]`。
    - Gemini：一块 `thought: true` 的部分，两块文字，末块带 `finishReason: 'STOP'`；地址以 `:streamGenerateContent` 结尾且查询串为 `?alt=sse`。
    - Anthropic：`message_start`、`content_block_start`、`ping`、一个 `thinking_delta`、两个 `text_delta`、`content_block_stop`、`message_delta`（`stop_reason: 'end_turn'`）、`message_stop`。
  - `'each protocol reports its own truncation signal'`：四种各一条流，结果 `truncated === true` 且没有 `interrupted`；Gemini 另试 `CONTINUATION`。
  - `'an OpenAI stream with no deltas takes its text from the final response'`。
  - `'a stream that fails, ends without its closing signal or goes silent keeps the text it delivered, marked incomplete'`：正文出错、干净结束但无结束信号、流内错误事件，三种都得到 `{ text: 'Hel', truncated: true, interrupted: 'interrupted' }`。
  - `'the same failures before any text reject, with the provider\'s reason when it gave one'`：Anthropic 的 `overloaded_error` 事件经 `callLLMAPI` 得到含 `aiInterrupted` 和 `Overloaded` 的提示；无结束信号的空流含 `aiInterrupted`。
  - `'stopping keeps the partial text as "stopped", and rejects as stopped when there is none'`：经 `callLLMAPI`，有文字时 `{ text: 'Hel', truncated: true, interrupted: 'stopped' }`，无文字时拒绝且 `error.stopped === true`。
  - `'text shown while streaming never carries an echoed opening marker'`：流的开头是 `<note>\n`，`onText` 收到的每一段都不含 `<note>`。
- [ ] **Step 2: 改现有测试**（`tests/current-release.test.cjs`）：`transports` 表里 Gemini 的路径改为 `…:streamGenerateContent`，查询串断言改为 Gemini 是 `?alt=sse`、其余为空；每个请求体断言 `stream === true`（Gemini 除外）。其余用例靠"整段 JSON 回答"这条路继续通过，不改。
- [ ] **Step 3: 运行 `npm test`，新用例失败**
- [ ] **Step 4: 实现**。`buildXxxRequest`、`extractXxxText`、`buildLLMRequest`、`extractLLMText`、`normalizeProviderBaseUrl` 从 `js/ai-optimize.js` 删除，逻辑搬进 `LLMTransport`；截断判断（`max_tokens` / `length` / `MAX_TOKENS` / `CONTINUATION` / `status === 'incomplete'`）整段回答和流式事件共用一个函数。`callLLMAPI` 里先算 New API 的网关地址，算不出时以 `modelGatewayUrl` 的文字拒绝（实施时改的：原计划写"照旧以 `aiBaseUrlRequired` 拒绝"，但原来的代码走不到那一句，用户看到的是没有翻译的 `modelGatewayUrl`；地址为空的情况在调用 `callLLMAPI` 之前已经用 `aiBaseUrlRequired` 拦下）。
- [ ] **Step 5: 运行 `npm run check`，全部通过**
- [ ] **Step 6: 提交** `git commit -m "新增 js/llm-transport.js：四种接口改为流式请求，中断时保留已收到的文字"`

### Task 3: 审阅面板边收边显示，「停止」按钮

**Files:**
- Modify: `js/ai-review.js`、`js/ai-workflow.js`、`js/ai-optimize.js`（`optimizeWithAI`）、`popup.html`、`_locales/{zh_CN,en,ja}/messages.json`
- Test: `tests/ai-review.test.cjs`、`tests/ai-workflow.test.cjs`

**Interfaces:**
- Consumes: `callLLMAPI` 的第九个参数和结果里的 `interrupted`（Task 2）。
- Produces:
  - `AIWorkflow.review(input, result, task, truncated)`：`truncated` 为 `'stopped'` 或 `'interrupted'` 时原样记入，其余真值记为 `true`。
  - `AIWorkflow.incompleteMessage(truncated) → 'aiStoppedWarning' | 'aiInterruptedWarning' | 'aiTruncatedWarning' | ''`。
  - `AIReview.stream(input, text, task)`：显示生成中的文字，不写存储。面板可见，结果框只读，「取消结果」停用，不显示警告，任务一栏显示"正在执行"。第一段文字立即显示、从开头看起，其后的文字每帧最多绘制一次，绘制时只改结果框（评审后改的：原来每段都同步重排整个面板，回答成批到达时页面会冻结数秒）。新文字是接在已显示文字后面的，用 `setRangeText` 追加而不是整个赋值，读者在结果框里选中的文字不会被清掉（第四轮评审后改的）。
  - `AIReview.setBusy(value, task, stop)`：`stop` 是函数时显示 `#aiStop`，点击后隐藏按钮并调用它一次；`value` 为假时清掉生成中的文字和 `stop`，面板回到存储里的待审结果（没有就隐藏）。不带 `stop` 的 `setBusy(true, …)`（本页自己写入任务记录后也会收到一次）不得把已有的 `stop` 清掉。`AIReview.show(…)` 也结束"生成中"的显示（实施时补上：结果一定稿就可以编辑，不必等任务记录清掉）。
  - `popup.html`：`#aiUndo` 之后加 `<button id="aiStop" class="text-button" hidden data-feature-message="aiStop"></button>`。

- [ ] **Step 1: 写失败的测试**
  - `tests/ai-workflow.test.cjs`：`'a review records why it is incomplete, and each reason has its own warning'`。
  - `tests/ai-review.test.cjs`（把 `state.context.fetch` 换成 `streamingFetch(state.requests)`）：
    - `'text appears in the review panel while it streams, read-only and unsaved, then becomes the editable review'`。
    - `'the stop button appears only while this editor generates, and stopping keeps the partial text for review'`：停止后 `memosAIReview.truncated === 'stopped'`，警告含 `aiStoppedWarning`，提示是 `aiStoppedWarning`，草稿不变，`#aiStop` 隐藏，`isBusy()` 为假。
    - `'stopping before any text leaves the draft and an earlier pending review as they were'`：提示是 `aiStopped`，不含 `aiOptimizeFailed`。
    - `'a connection lost midway leaves the partial text marked as interrupted'`。
    - `'while text streams, adopting, discarding and editing the result do nothing'`（Review Focus 4）。
    - `'a job seen through storage does not take the stop button away from the editor that started it'`：生成中 `chrome.storage.onChanged.emit({ memosAIJob: { newValue: {...} } }, 'local')` 之后 `#aiStop` 仍可见。
- [ ] **Step 2: 运行 `npm test`，新用例失败**
- [ ] **Step 3: 实现**。`optimizeWithAI` 为每次生成新建一个 `AbortController`；结束后的提示取 `AIWorkflow.incompleteMessage(…)`，为空时是 `aiReviewReady`；被停止且无文字时只提示 `aiStopped`，不加"AI 优化失败"的前缀。结果框在用户停留在底部时跟随滚动。
- [ ] **Step 4: 运行 `npm run check`，全部通过**
- [ ] **Step 5: 提交** `git commit -m "审阅面板边收边显示生成的文字，新增「停止」按钮，停止或中断时保留已生成的部分"`

### Task 4: 模拟服务器、浏览器验收、文档

**Files:**
- Modify: `scripts/fixture-server.cjs`、`scripts/check-chrome.cjs`、`README.md`、`CHANGELOG.md`、`docs/superpowers/specs/2026-11-20-optimization-roadmap-design.md`（状态行）

- [ ] **Step 1: `scripts/fixture-server.cjs`**：`/v1/chat/completions` 收到 `stream: true` 时以事件流回答：立即发出那句话的前 8 个字，`state.aiDelay` 的十分之一之后再发 2 个字，等 `state.aiDelay` 毫秒后发其余部分（带 `finish_reason: 'stop'`）和 `[DONE]`（中间那一段是评审后加的，让验收能看到第一段之后的文字也画了出来；`state.refuseStream` 为真时对流式请求回 400，也是评审后加的）；连接已断时不再写。不带 `stream` 的请求照旧。
- [ ] **Step 2: `scripts/check-chrome.cjs`**：在 "AI output can be edited, appended and undone from the other editor" 之后加一条：`aiDelay` 设为 6000，侧栏点 AI，等结果框里出现前 8 个字且 `#aiStop` 可见，断言结果框只读，点 `#aiStop`，等到不再忙且存储里的待审结果 `truncated === 'stopped'`；断言草稿不变、结果框只有前 8 个字、警告可见、`#aiStop` 隐藏；最后点「取消结果」并把 `aiDelay` 复位。生成期间另断言弹窗那一侧处于"正在执行"、没有「停止」按钮、也不显示生成中的文字（实施时补上）。通过名：`Stopping a generation leaves the draft unchanged and the partial result ready for review`。（评审后改的：停止之前先等第 9、10 个字显示出来，结果框是前 10 个字；警告改为断言含"手动停止"的那句，因为剪藏稿缺少来源链接时警告本来就会显示。另加一条 `A gateway that refuses to stream still delivers its answer, asked again in one piece`。第四轮评审后：前 8 个字显示出来时选中第 3 到第 6 个字，第 9、10 个字画出来之后断言选区还在。）
- [ ] **Step 3: 按 `e2e-environment` 的跑法运行验收脚本（先备份 `artifacts/acceptance-<版本>`，跑完还原），全部 PASS**
- [ ] **Step 4: 文档**。`README.md` 的 AI 一段写明边生成边显示、可停止、停止或中断时保留已生成的部分；`CHANGELOG.md` "未发布"加一条；路线图状态行加上本批的提交范围和计划路径，A4 第一阶段标为已完成。
- [ ] **Step 5: 运行 `npm run check`，提交** `git commit -m "模拟服务器按事件流回答，验收脚本覆盖生成中停止，更新说明、修改记录与路线图进度"`

## 需要人工确认的事（自动测试不调用真实模型）

- 四家服务商各跑一次，确认文字是逐步出现的，结束后结果完整、可编辑。
- 用一个会长时间思考的模型跑一次，确认思考期间不会被 90 秒的静默超时打断；如果会，把超时调大或改为可配置。
- New API 网关：确认所用网关支持流式；不支持时应当照旧在结束后一次显示。
