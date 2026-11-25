/* global Http */
/* exported LLMTransport */
/**
 * The provider protocols: how each one's generation request is built and how its answer is read, as a
 * stream of events or whole. Nothing here touches the page or reads the settings.
 */
var LLMTransport = (function () {
  /** What each protocol calls running into the output limit. */
  const limits = ['max_tokens', 'max_output_tokens', 'length', 'MAX_TOKENS', 'CONTINUATION', 'incomplete'];
  /** What each protocol calls an answer the model brought to its end. */
  const finished = ['stop', 'end_turn', 'stop_sequence', 'STOP', 'completed'];

  /**
   * How an answer ended, from the reason given for it: '' for whole, 'limit' at the output limit, and 'cut'
   * for any other reason, known or not: a filter, a refusal, a server out of resources. Only the reasons
   * known to mean a whole answer count as one, so a reason added later does not pass for it.
   */
  function ending(finish) {
    if (finish === undefined || finish === null || finish === '') return '';
    if (limits.includes(finish)) return 'limit';
    return finished.includes(finish) ? '' : 'cut';
  }

  /** What generate() resolves with for text that ended as `how` says. An answer cut before any text is an empty one. */
  function outcome(text, how) {
    if (how === 'cut' && text.trim()) return { text: text, truncated: true, interrupted: 'ended' };
    return { text: text, truncated: how === 'limit' };
  }

  /** The text of content that is a string or a list of typed parts. */
  function plainText(content) {
    if (Array.isArray(content))
      return content
        .filter(part => part && part.type === 'text')
        .map(part => part.text || '')
        .join('');
    return typeof content === 'string' ? content : '';
  }

  function openaiText(response) {
    if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
    if (!Array.isArray(response.output)) return '';
    return response.output
      .flatMap(item => item.content || [])
      .map(part => (part.type === 'output_text' ? part.text || '' : ''))
      .join('');
  }

  /** Why an OpenAI response ended: an incomplete one says what cut it. */
  function openaiFinish(response) {
    return (response.status === 'incomplete' && response.incomplete_details?.reason) || response.status;
  }

  /** The visible text of a Gemini answer or of one event of its stream: thoughts are not part of it. */
  function geminiText(response) {
    const candidate = response.candidates && response.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map(part => (part.thought ? '' : part.text || '')).join('');
  }

  /** The request without the stream flag of its body, for the answer in one piece; none when it has no flag. */
  function unflagged(request) {
    if (!request.body.stream) return undefined;
    const body = Object.assign({}, request.body);
    delete body.stream;
    return { url: request.url, headers: request.headers, body: body };
  }

  /** The reason an error gives in words: its message, or the error itself where that is the words. */
  function worded(error) {
    return (error && error.message) || error;
  }

  /**
   * For each protocol: request() builds what is sent, plain() turns that into the request for the same
   * answer in one piece, or nothing when it is that already, whole() reads an answer that arrived in one
   * piece as { text, finish }, and event() reads one event of a stream into `answer`, which takes text
   * through add(), all of the text at once through all(), the reason the answer ended through end() and
   * an error the server reports through fail(), as its reason in words and then all of what it said. That
   * is the whole event: what an error rejects may stand beside it there, as a parameter or a code of its own.
   */
  const protocols = {
    'openai-responses': {
      request: (provider, input) => ({
        url: input.apiUrl || provider.apiUrl,
        headers: { Authorization: 'Bearer ' + input.apiKey },
        body: {
          model: input.model,
          instructions: input.system,
          input: input.user,
          max_output_tokens: input.maxTokens,
          stream: true
        }
      }),
      plain: unflagged,
      whole: response => ({ text: openaiText(response), finish: openaiFinish(response) }),
      event(event, answer) {
        if (event.type === 'response.output_text.delta') answer.add(event.delta);
        else if (event.type === 'error') answer.fail(event.message, event);
        else if (event.type === 'response.failed') answer.fail(worded(event.response?.error), event);
        else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          const response = event.response || {};
          // The finished response carries the whole text. A stream may have brought none of it in deltas,
          // or not all: a gateway that passes on only some, or a delta that arrived damaged.
          answer.all(openaiText(response));
          answer.end(openaiFinish(response));
        }
      }
    },
    'chat-completions': {
      request: (provider, input) => ({
        url: input.apiUrl || provider.apiUrl,
        headers: { Authorization: 'Bearer ' + input.apiKey },
        body: {
          model: input.model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user }
          ],
          // Without a limit none is sent: a gateway fronts models with different ceilings.
          ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
          stream: true
        }
      }),
      plain: unflagged,
      whole: response => ({
        text: plainText(response.choices?.[0]?.message?.content),
        finish: response.choices?.[0]?.finish_reason
      }),
      event(event, answer) {
        if (event.error) answer.fail(worded(event.error), event);
        const choice = event.choices && event.choices[0];
        if (!choice) return;
        // Reasoning arrives beside the content, under a name of its own, and is not part of the answer.
        // A gateway that does not really stream may send the whole message as its one event.
        const part = choice.delta || choice.message;
        answer.add(plainText(part && part.content));
        if (choice.finish_reason) answer.end(choice.finish_reason);
      }
    },
    gemini: {
      request: (provider, input) => ({
        // The streaming method answers with server-sent events only when asked to.
        url: (input.apiUrl || provider.apiUrl)
          .replace('{model}', encodeURIComponent(input.model))
          .replace(/:generateContent$/, ':streamGenerateContent?alt=sse'),
        headers: { 'x-goog-api-key': input.apiKey },
        body: {
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [{ role: 'user', parts: [{ text: input.user }] }],
          generationConfig: { maxOutputTokens: input.maxTokens }
        }
      }),
      // Streaming is a method of its own here, named in the address, with no flag in the body.
      plain(request) {
        const url = request.url.replace(/:streamGenerateContent\?alt=sse$/, ':generateContent');
        return url === request.url ? undefined : { url: url, headers: request.headers, body: request.body };
      },
      whole: response => ({ text: geminiText(response), finish: response.candidates?.[0]?.finishReason }),
      event(event, answer) {
        if (event.error) answer.fail(worded(event.error), event);
        answer.add(geminiText(event));
        // A prompt the service blocks is answered without candidates: that answer is over, and has no text.
        const finish = event.candidates?.[0]?.finishReason || event.promptFeedback?.blockReason;
        if (finish) answer.end(finish);
      }
    },
    anthropic: {
      request: (provider, input) => ({
        url: input.apiUrl || provider.apiUrl,
        headers: {
          'x-api-key': input.apiKey,
          'anthropic-version': provider.anthropicVersion,
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: {
          model: input.model,
          system: input.system,
          messages: [{ role: 'user', content: input.user }],
          max_tokens: input.maxTokens,
          stream: true
        }
      }),
      plain: unflagged,
      whole: response => ({
        text: Array.isArray(response.content) ? plainText(response.content) : '',
        finish: response.stop_reason
      }),
      event(event, answer) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') answer.add(event.delta.text);
        else if (event.type === 'message_delta' && event.delta?.stop_reason) answer.end(event.delta.stop_reason);
        else if (event.type === 'message_stop') answer.end();
        else if (event.type === 'error') answer.fail(worded(event.error), event);
      }
    }
  };

  /**
   * The request for one generation as { url, headers, body }. `system` and `user` are the two messages,
   * `maxTokens` the output limit, and `apiUrl` an address to use instead of the provider's own.
   */
  function request(provider, input) {
    const protocol = protocols[provider.endpointType];
    if (!protocol) throw new Error('未知的提供商类型');
    return protocol.request(provider, input);
  }

  // An event stream that reported an error, or closed before saying it was done. `said` is all of the error
  // the server reported, kept the way a refused request keeps what it was answered with.
  function broken(reason, said) {
    const failure = { status: 0, statusText: 'stream', reason: typeof reason === 'string' ? reason : '' };
    if (said !== undefined) failure.responseJSON = said;
    return failure;
  }

  /** How a refusal names streaming. The word has to start there: "upstream" names something else. */
  const namesStream = /(?<![a-z])stream|\bSSE\b|server-sent|流式/i;
  /** A name alone, as a code or the path of a field is written: "stream", "body.stream", "stream_not_supported". */
  const nameAlone = /^[\w.$[\]/-]+$/;
  /** That name, and "is not available" in the ways it is said, as parts of the pattern below. */
  const streaming = '(?:' + namesStream.source + ')';
  const unavailable = "(?:\\bunavailable|(?:\\bnot|n't|\\bno\\s+longer)\\s+(?:\\w+\\s+){0,2}?available)\\b";
  /** How a word begins that tells what became of a stream, or names what else may not be available. */
  const mishap =
    '(?:fail|error|clos|disconnect|reset|abort|interrupt|terminat|lost|broke|drop|timed|timeout|because|upstream' +
    '|connection|失败|中断|断开|异常|超时|错误|上游|连接)';
  /** The stream that comes from upstream is a stream, not streaming: "the upstream stream", "上游流式服务". */
  const notFromUpstream = '(?<!\\bupstream\\s|上游)';
  /** The rest of the word that names streaming, with what closes a quote or a bracket, and the flag as it is set. */
  const restOfName = '[\\w\'"`)\\]-]*(?:\\s*[:=]\\s*["\'`]?true\\b["\'`]?)?';
  /**
   * The words that say something is not to be had or not to be sent, as distinct from a request that went
   * wrong. Three of them are a server's words for a failure too: "unavailable", "unknown" and "unexpected"
   * count only where they are said of streaming or of a parameter, not of an upstream, an error or an end.
   */
  const refuses = new RegExp(
    [
      "(?:\\bnot|n't|\\bno longer)\\s+(?:\\w+\\s+){0,2}?(?:support|allowed|enabled|permitted|implemented|accepted)",
      '\\bun(?:supported|implemented)\\b',
      '\\b(?:disabled|disallowed|forbidden)\\b',
      // Had only somewhere else: "supported only on the standard tier", "only available to verified accounts".
      '\\b(?:supported|available|allowed|enabled|permitted|offered)\\s+only\\b',
      '\\bonly\\s+(?:\\w+\\s+)?(?:supported|available|allowed|enabled|permitted|offered)\\b',
      // "No streaming here". "No stream data received", "no stream was returned" tell of a stream that
      // brought nothing.
      '\\bno\\s+stream(?:ing|ed|s)?\\b' +
        '(?!\\s+(?:data|response|events?|chunks?|content|output|was|were|found|received|returned)\\b)',
      '\\bnon[-\\s]?stream',
      // What the flag has to be, or what to do with it: "stream must be false", "set stream to false",
      // "requires stream=false", "please disable streaming", "turn off streaming".
      '\\b(?:must|should|needs?\\s+to|ha(?:s|ve)\\s+to)\\s+be\\s+(?:set\\s+to\\s+)?(?:false|off|disabled|turned\\s+off)\\b',
      'stream["\'`]?\\s*(?:[:=]+|\\bto\\b)\\s*["\'`]?(?:false|off)\\b',
      '\\b(?:disable|turn(?:ing)?\\s+off|switch(?:ing)?\\s+off|without)\\s+(?:the\\s+)?(?:stream|SSE)',
      '\\binvalid\\s+(?:stream(?:ing)?\\s+)?(?:value|parameter|argument|field)\\b',
      // Streaming as what is not available: "Streaming is unavailable", "streaming for this model isn't
      // available yet", "stream=true is not available". Between the two stands nothing that parts clauses
      // or begins as a mishap does: "stream closed: not available" and "stream failed because upstream is
      // unavailable" say it of something else.
      notFromUpstream + streaming + restOfName + '(?:\\s+(?!' + mishap + ')[^\\s,:;]+){0,8}?\\s*' + unavailable,
      // Or as what something is not available for, in or by way of: "not available for your streaming
      // request", "unavailable in stream mode". A service that is "unavailable while streaming" failed at it.
      unavailable +
        '\\s+(?:\\w+\\s+){0,2}?(?:for|in|with|when|if|via|over|through|using)\\s+(?:[^\\s,:;]+\\s+){0,3}?["\'`(]?' +
        streaming,
      // What is not known is a name, as a parameter has one: "Unknown parameter: 'stream'", "unexpected
      // keyword argument 'stream'", "unknown field". An end or an error that was not expected has none.
      '\\bun(?:known|expected|recogni[sz]ed)\\s+(?:\\w+\\s+){0,2}?' +
        '(?:param(?:eter)?|field|arg(?:ument)?|key(?:word)?|propert(?:y|ies)|option|name|attribute|value)s?\\b',
      '不支持|不允许|未开启|未启用|禁用|禁止|暂不(?!可用)|仅支持|只支持|仅限|仅对|只对',
      // The same of streaming in Chinese: "流式输出暂不可用", "无法使用流式输出", "不可用于流式调用".
      // "上游服务不可用，流式请求失败" and "流式请求失败 上游服务不可用" say it of the upstream.
      notFromUpstream + streaming + '(?:(?!' + mishap + ')[^，,。；;：:！!？?\\n]){0,20}?(?:不可用|无法使用)',
      '(?:不可用于|无法使用)[^，,。；;：:！!？?\\n]{0,8}?' + streaming,
      // To turn streaming off is asked of the reader. A streaming connection that was closed is not that.
      '非流式|(?:关闭|关掉|停用|取消)\\s*(?:流式|stream|SSE)(?!\\s*连接)|(?:为|成)\\s*["\'`]?(?:false|关闭)'
    ].join('|'),
    'i'
  );
  /**
   * The request at hand, named as what something else was wanted for: "for your streaming request", "in
   * this stream call". That says what was asked, not what is refused. A request the sentence refuses is
   * named without such a word before it ("does not support the streaming request"), and "a streaming
   * request" is any of them, not this one.
   */
  const forTheRequest = /\b(?:for|in|on|of|to|by|from)\s+(?:your|this|the)\s+stream(?:ing|ed)?\s+(?:request|call)\b/gi;
  /** Where one sentence of a message ends and the next begins. */
  const sentenceEnd = /[.!?。！？;；]+(?:\s+|$)|\n+/;
  /** The stream flag as a request written out carries it, in JSON or as a Python dict, after another field or first. */
  const echoedFlag = /([{,]\s*)(["']?)stream\2\s*:\s*(?:true|True)\b/g;
  /** The field of an error that names what it rejects, where the error is written out in text: "param":"stream". */
  const writtenParameter = /(["']?)\b(?:param(?:eter)?|field)\1\s*[:=]\s*(["'])([\w.$[\]/-]+)\2/gi;
  /** A name alone that is the stream flag itself, as the last part of a path: "stream", "body.stream". */
  const flagAlone = /(?:^|[.$[\]/])stream(?:ing)?\]?$/i;
  /** A name alone as the words it is made of: "stream_not_supported", "StreamingNotSupported". */
  const inWords = name => name.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[\W_]+/g, ' ');
  /** How a name alone names the model: "model", "body.model", "model_not_found". */
  const namesModel = /(?<![a-z])model/i;

  /**
   * Calls each(text) for every string in a value read from JSON, however deep. With `names` the name of
   * every field is a string too, given as each(name, true), except that of a stream flag that is on: that
   * is the request repeated.
   */
  function strings(value, each, names) {
    if (typeof value === 'string') each(value);
    else if (Array.isArray(value)) value.forEach(item => strings(item, each, names));
    else if (value && typeof value === 'object')
      for (const [name, item] of Object.entries(value)) {
        if (names && name === 'stream' && item === true) continue;
        if (names) each(name, true);
        strings(item, each, names);
      }
  }

  /** What text that is JSON itself holds, as an error passed on from upstream may be; nothing for other text. */
  function embedded(text) {
    if (!/^\s*[{[]/.test(text)) return undefined;
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' ? value : undefined;
    } catch (_) {
      return undefined;
    }
  }

  /**
   * Whether the server refused the request for asking for a stream. Servers word and place that reason
   * each in their own way: as a message, a code, the name of the refused field, or a list of such. A
   * gateway may pass on the error it got from upstream as text, written as JSON or as a Python dict. So
   * all of a refusal is read, text that is JSON as what it holds, and it is one when a field of it is the
   * name of the stream flag alone, when text in it gives that name as the parameter it rejects, or when a
   * sentence in it both names streaming and says that is not to be had. A code is read as the sentence its
   * words make. Naming streaming is not enough: a context that is too long may be reported as that of "your
   * stream request". Being had only elsewhere, as on another tier, is not being had.
   *
   * Nor is every word of a refusal enough. A stream that broke is reported in some of the same words: an
   * end that was "unexpected", an "unknown" error, an upstream that is "unavailable". Those tell what
   * became of a stream, and refuse only where they are said of streaming itself or of a parameter.
   *
   * A model that is "not available for your streaming request" may be one that does not stream, or one
   * that is not to be had at all. What the error names as rejected decides: with the model as its
   * parameter, in the path of its field or in its code, such a sentence refuses the model. Without that it
   * is read as a refusal to stream. So is, whatever the error names, a sentence that refuses the request
   * itself: "This model does not support the streaming request", "Your streaming request is not supported
   * by this model".
   *
   * An error may also repeat the request it refuses, so what the request with this `body` said itself does
   * not count: its stream flag, and any text of its own that names streaming, such as a note about it.
   *
   * The refusal may come with the status 400 or 422, or as an event of a stream that was opened: that one
   * has no status, and the failure keeps what the server said. 406 is a refusal by its status: what the
   * request said it takes cannot be given, and the request for JSON alone takes something else.
   *
   * Not asking again when the refusal was this one leaves the model unusable. Asking again when a refused
   * request had another reason costs one more request, refused the same way. Asking again when a stream
   * that was opened broke costs more: the answer is generated a second time.
   */
  function refusesStream(failure, body) {
    if (failure.status === 406) return true;
    const reported = failure.statusText === 'stream' && failure.responseJSON !== undefined;
    if (!reported && failure.status !== 400 && failure.status !== 422) return false;
    const own = [];
    strings(body, text => {
      // As it was sent, and as it reads inside JSON that is quoted as text.
      if (namesStream.test(text)) own.push(text, JSON.stringify(text).slice(1, -1));
    });
    // What the refusal says in sentences, and the names it gives alone, each with whether it is the name
    // of a field. A code, the path of a field and a parameter are values.
    const said = [];
    const alone = [];
    const hear = (text, isName) => {
      const held = isName ? undefined : embedded(text);
      if (held !== undefined) return strings(held, hear, true);
      for (const mine of own) text = text.split(mine).join('');
      text = text.replace(echoedFlag, '$1').trim();
      if (nameAlone.test(text)) return alone.push([text, !!isName]);
      said.push(text);
      for (const written of text.matchAll(writtenParameter)) alone.push([written[3], false]);
    };
    if (failure.responseJSON === undefined) hear(String(failure.responseText || ''));
    else strings(failure.responseJSON, hear, true);
    const model = alone.some(([name, isName]) => !isName && namesModel.test(name));
    // Where the model is what the error rejects, a sentence about the model that names streaming only as
    // what the model was wanted for refuses the model.
    const refusal = sentence =>
      refuses.test(sentence) &&
      namesStream.test(model && /\bmodel\b/i.test(sentence) ? sentence.replace(forTheRequest, '') : sentence);
    // A name alone refuses streaming as the flag itself, or as a code whose words do, read as a sentence is:
    // those of "stream_timeout" and of "unexpected_end_of_stream" tell what became of a stream.
    return (
      alone.some(([name]) => flagAlone.test(name) || refusal(inWords(name))) ||
      said.some(text => text.split(sentenceEnd).some(refusal))
    );
  }

  /**
   * Sends the request and resolves with { text, truncated } once the answer is complete; `truncated` means
   * it ran into the output limit. The answer is complete with the event that ends it, whether or not the
   * server closes the connection then. onText(text) is called with the whole text so far each time more of a
   * streamed answer arrives: once for all that arrived together, however many events that was. `signal`
   * lets the caller stop, and `idle` is the longest silence allowed.
   *
   * An answer cut off on the way (stopped, timed out, connection lost, an error reported in the stream, or
   * a stream closed before saying it was done) resolves with what arrived, as
   * { text, truncated: true, interrupted: 'stopped' | 'interrupted' }. With no text to keep it rejects
   * with the failure, which for the last two causes is { status: 0, statusText: 'stream', reason }, with
   * the error the server reported as its responseJSON.
   *
   * An event that was meant as JSON and cannot be read may have carried text. The answer is then missing a
   * part, though the stream goes on to say it is done: it resolves as 'interrupted' too, or rejects when
   * nothing else arrived.
   *
   * An answer the provider ended for a reason other than being finished or at the limit, such as a content
   * filter, resolves with its text as { text, truncated: true, interrupted: 'ended' }; without text it is
   * an empty answer like any other.
   *
   * Not every model or gateway streams. One that answers in one piece is read that way, and one that
   * refuses the request for asking for a stream, or with 406 for the event stream it says it takes, is
   * asked once more for the answer in one piece, as JSON alone: without the stream flag, or for Gemini by
   * the method that does not stream. The refusal may be the answer to the request, or the first thing a
   * stream that was opened says; a stream that has brought text is not asked for again.
   */
  async function generate(endpointType, request, options = {}) {
    const protocol = protocols[endpointType];
    if (!protocol) throw new Error('未知的提供商类型');
    try {
      return await read(protocol, request, options);
    } catch (failure) {
      const whole = failure && protocol.plain(request);
      if (!whole || !refusesStream(failure, request.body)) throw failure;
      whole.accept = 'application/json';
      return read(protocol, whole, options);
    }
  }

  /** One request and its answer, as generate() describes them. */
  async function read(protocol, request, { signal, onText, idle }) {
    let text = '',
      told = '',
      done = false,
      damaged = false,
      how = '';
    const answer = {
      text: () => text,
      add(more) {
        if (typeof more === 'string') text += more;
      },
      all(whole) {
        if (typeof whole !== 'string' || !whole) return;
        text = whole;
        // Nothing is missing from it, whatever was lost on the way.
        damaged = false;
      },
      end(finish) {
        done = true;
        // The reason comes once; a closing event after it gives none.
        how = how || ending(finish);
      },
      fail(reason, said) {
        // What reports an error has not ended the answer, though the event it came in reads as its end too.
        done = false;
        throw broken(reason, said);
      }
    };
    try {
      const reply = await Http.stream({
        url: request.url,
        headers: request.headers,
        body: request.body,
        accept: request.accept,
        idle: idle,
        signal: signal,
        // A buffering proxy can deliver thousands of events at once: the caller hears of them once.
        afterPiece() {
          if (!onText || text === told) return;
          told = text;
          onText(text);
        },
        onEvent(data, name) {
          // An event may say it is an error by its name alone, with data in a shape of the server's own.
          const named = /^error$/i.test(name || '');
          // The line a Chat Completions stream closes with; nothing else outside JSON carries meaning. Under
          // the name of an error it closes nothing: it is what that error has for data.
          if (data === '[DONE]' && !named) answer.end();
          else {
            let event;
            try {
              event = JSON.parse(data);
            } catch (_) {
              if (named) answer.fail(data, data);
              // Data that never was JSON, such as a gateway's own note, carries nothing. What starts as
              // JSON and does not read as it is an event that was damaged, and what it carried is lost.
              if (/^\s*[{[]/.test(data)) damaged = true;
              return false;
            }
            if (event && typeof event === 'object') protocol.event(event, answer);
            // The protocol reads the errors it knows first. Any other is still one, by its name.
            if (named)
              answer.fail(
                typeof event === 'string'
                  ? event
                  : event?.message || event?.error?.message || event?.error || event?.detail,
                event
              );
          }
          // Nothing after the end of the answer is waited for: a server may hold the connection open.
          return done;
        }
      });
      if (!reply.streamed) {
        // A gateway that does not stream answers the same request in one piece.
        const whole = protocol.whole(reply.data || {});
        return outcome(whole.text, ending(whole.finish));
      }
      if (!done) throw broken('');
    } catch (failure) {
      // Only a failed request leaves a partial answer behind; anything else is a defect to surface.
      if (!failure || typeof failure.status !== 'number') throw failure;
      // An answer that said it was done lost nothing, however its connection ended.
      if (!done) {
        if (!text.trim()) throw failure;
        return { text: text, truncated: true, interrupted: failure.statusText === 'abort' ? 'stopped' : 'interrupted' };
      }
    }
    if (damaged) {
      // Text is missing from somewhere in the answer: it is not whole, whatever its last event said.
      if (!text.trim()) throw broken('');
      return { text: text, truncated: true, interrupted: 'interrupted' };
    }
    return outcome(text, how);
  }

  return { request: request, generate: generate };
})();
