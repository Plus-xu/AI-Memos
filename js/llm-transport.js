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

  /**
   * For each protocol: request() builds what is sent, plain() turns that into the request for the same
   * answer in one piece, or nothing when it is that already, whole() reads an answer that arrived in one
   * piece as { text, finish }, and event() reads one event of a stream into `answer`, which takes text
   * through add(), all of the text at once through all(), the reason the answer ended through end() and
   * an error the server reports through fail().
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
        else if (event.type === 'error') answer.fail(event.message);
        else if (event.type === 'response.failed') answer.fail(event.response?.error?.message);
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
        if (event.error) answer.fail(event.error.message);
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
        if (event.error) answer.fail(event.error.message);
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
        else if (event.type === 'error') answer.fail(event.error?.message);
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

  // An event stream that reported an error, or closed before saying it was done.
  function broken(reason) {
    return { status: 0, statusText: 'stream', reason: typeof reason === 'string' ? reason : '' };
  }

  /** How a refusal names streaming. The word has to start there: "upstream" names something else. */
  const namesStream = /(?<![a-z])stream|\bSSE\b|server-sent|流式/i;
  /** A name alone, as a code or the path of a field is written: "stream", "body.stream", "stream_not_supported". */
  const nameAlone = /^[\w.$[\]/-]+$/;
  /** The words that say something is not to be had or not to be sent, as distinct from a request that went wrong. */
  const refuses = new RegExp(
    [
      "(?:\\bnot|n't|\\bno longer)\\s+(?:\\w+\\s+){0,2}?(?:support|available|allowed|enabled|permitted|implemented|accepted)",
      '\\bun(?:supported|available|recogni[sz]ed|expected|known)\\b',
      '\\b(?:disabled|disallowed|forbidden)\\b',
      // Had only somewhere else: "supported only on the standard tier", "only available to verified accounts".
      '\\b(?:supported|available|allowed|enabled|permitted|offered)\\s+only\\b',
      '\\bonly\\s+(?:\\w+\\s+)?(?:supported|available|allowed|enabled|permitted|offered)\\b',
      '\\bno\\s+stream',
      '\\bnon-?stream',
      // What the flag has to be, or what to do with it: "stream must be false", "set stream to false",
      // "requires stream=false", "please disable streaming", "turn off streaming".
      '\\b(?:must|should|needs?\\s+to|ha(?:s|ve)\\s+to)\\s+be\\s+(?:set\\s+to\\s+)?(?:false|off|disabled|turned\\s+off)\\b',
      'stream["\'`]?\\s*(?:[:=]+|\\bto\\b)\\s*["\'`]?(?:false|off)\\b',
      '\\b(?:disable|turn(?:ing)?\\s+off|switch(?:ing)?\\s+off|without)\\s+(?:the\\s+)?(?:stream|SSE)',
      '\\binvalid\\s+(?:value|parameter|argument|field)\\b',
      '不支持|不允许|不可用|未开启|未启用|无法使用|禁用|禁止|暂不|仅支持|只支持|仅限|仅对|只对',
      '非流式|(?:关闭|关掉|停用|取消)\\s*(?:流式|stream|SSE)|(?:为|成)\\s*["\'`]?(?:false|关闭)'
    ].join('|'),
    'i'
  );
  /** The request at hand, called by how it was sent: that says what was asked, not what is refused. */
  const theRequest = /\b(?:your|this|the|a)\s+stream(?:ing|ed)?\s+(?:request|call)\b/gi;
  /** Where one sentence of a message ends and the next begins. */
  const sentenceEnd = /[.!?。！？;；]+(?:\s+|$)|\n+/;
  /** The stream flag as a request written out carries it, in JSON or as a Python dict, after another field or first. */
  const echoedFlag = /([{,]\s*)(["']?)stream\2\s*:\s*(?:true|True)\b/g;

  /**
   * Calls each(text) for every string in a value read from JSON, however deep. With `names` the name of
   * every field is a string too, except that of a stream flag that is on: that is the request repeated.
   */
  function strings(value, each, names) {
    if (typeof value === 'string') each(value);
    else if (Array.isArray(value)) value.forEach(item => strings(item, each, names));
    else if (value && typeof value === 'object')
      for (const [name, item] of Object.entries(value)) {
        if (names && name === 'stream' && item === true) continue;
        if (names) each(name);
        strings(item, each, names);
      }
  }

  /**
   * Whether the server refused the request for asking for a stream. Servers word and place that reason
   * each in their own way: as a message, a code, the name of the refused field, or a list of such. So all
   * of a refusal is read, and it is one when a field of it is the name of streaming alone, or when a
   * sentence in it both names streaming and says that is not to be had. Naming it is not enough: a
   * context that is too long may be reported as that of "your stream request", and so may a model that is
   * not to be had. Being had only elsewhere, as on another tier, is not being had. An error may also repeat
   * the request it refuses, so what the request with this `body` said itself does not count: its stream
   * flag, and any text of its own that names streaming, such as a note about it.
   *
   * 406 is a refusal by its status: what the request said it takes cannot be given, and the request for
   * JSON alone takes something else.
   *
   * Asking again when the refusal had another reason costs one more request, refused the same way. Not
   * asking again when it was this one leaves the model unusable.
   */
  function refusesStream(failure, body) {
    if (failure.status === 406) return true;
    if (failure.status !== 400 && failure.status !== 422) return false;
    const own = [];
    strings(body, text => {
      // As it was sent, and as it reads inside JSON that is quoted as text.
      if (namesStream.test(text)) own.push(text, JSON.stringify(text).slice(1, -1));
    });
    let refused = false;
    // A sentence about the model that names streaming only in calling the request a stream request
    // refuses the model: "The model m is not available for your streaming request".
    const refusal = sentence =>
      refuses.test(sentence) &&
      namesStream.test(/\bmodel\b/i.test(sentence) ? sentence.replace(theRequest, '') : sentence);
    const read = text => {
      for (const said of own) text = text.split(said).join('');
      text = text.replace(echoedFlag, '$1').trim();
      if (nameAlone.test(text) ? namesStream.test(text) : text.split(sentenceEnd).some(refusal)) refused = true;
    };
    if (failure.responseJSON === undefined) read(String(failure.responseText || ''));
    else strings(failure.responseJSON, read, true);
    return refused;
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
   * with the failure, which for the last two causes is { status: 0, statusText: 'stream', reason }.
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
   * the method that does not stream.
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
      fail(reason) {
        throw broken(reason);
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
        onEvent(data) {
          // The line a Chat Completions stream closes with; nothing else outside JSON carries meaning.
          if (data === '[DONE]') answer.end();
          else {
            let event;
            try {
              event = JSON.parse(data);
            } catch (_) {
              // Data that never was JSON, such as a gateway's own note, carries nothing. What starts as
              // JSON and does not read as it is an event that was damaged, and what it carried is lost.
              if (/^\s*[{[]/.test(data)) damaged = true;
              return false;
            }
            if (event && typeof event === 'object') protocol.event(event, answer);
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
