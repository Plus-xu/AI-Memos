/* global Http */
/* exported LLMTransport */
/**
 * The provider protocols: how each one's generation request is built and how its answer is read, as a
 * stream of events or whole. Nothing here touches the page or reads the settings.
 */
var LLMTransport = (function () {
  /** What each protocol calls running into the output limit. */
  const limits = ['max_tokens', 'length', 'MAX_TOKENS', 'CONTINUATION', 'incomplete'];

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

  /** The visible text of a Gemini answer or of one event of its stream: thoughts are not part of it. */
  function geminiText(response) {
    const candidate = response.candidates && response.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map(part => (part.thought ? '' : part.text || '')).join('');
  }

  /**
   * For each protocol: request() builds what is sent, whole() reads an answer that arrived in one piece as
   * { text, finish }, and event() reads one event of a stream into `answer`, which takes text through
   * add(), the reason the answer ended through end() and an error the server reports through fail().
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
      whole: response => ({ text: openaiText(response), finish: response.status }),
      event(event, answer) {
        if (event.type === 'response.output_text.delta') answer.add(event.delta);
        else if (event.type === 'error') answer.fail(event.message);
        else if (event.type === 'response.failed') answer.fail(event.response?.error?.message);
        else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          const response = event.response || {};
          // A stream may carry no deltas, only the finished response.
          if (!answer.text()) answer.add(openaiText(response));
          answer.end(response.status);
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
      whole: response => ({
        text: plainText(response.choices?.[0]?.message?.content),
        finish: response.choices?.[0]?.finish_reason
      }),
      event(event, answer) {
        if (event.error) answer.fail(event.error.message);
        const choice = event.choices && event.choices[0];
        if (!choice) return;
        // Reasoning arrives beside the content, under a name of its own, and is not part of the answer.
        answer.add(plainText(choice.delta && choice.delta.content));
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
      whole: response => ({ text: geminiText(response), finish: response.candidates?.[0]?.finishReason }),
      event(event, answer) {
        if (event.error) answer.fail(event.error.message);
        answer.add(geminiText(event));
        const finish = event.candidates?.[0]?.finishReason;
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

  /**
   * Sends the request and resolves with { text, truncated } once the answer is complete; `truncated` means
   * it ran into the output limit. onText(text) is called with the whole text so far each time more of a
   * streamed answer arrives. `signal` lets the caller stop, and `idle` is the longest silence allowed.
   *
   * An answer cut off on the way (stopped, timed out, connection lost, an error reported in the stream, or
   * a stream closed before saying it was done) resolves with what arrived, as
   * { text, truncated: true, interrupted: 'stopped' | 'interrupted' }. With no text to keep it rejects
   * with the failure, which for the last two causes is { status: 0, statusText: 'stream', reason }.
   */
  async function generate(endpointType, request, { signal, onText, idle } = {}) {
    const protocol = protocols[endpointType];
    if (!protocol) throw new Error('未知的提供商类型');
    let text = '',
      done = false,
      truncated = false;
    const answer = {
      text: () => text,
      add(more) {
        if (typeof more !== 'string' || !more) return;
        text += more;
        if (onText) onText(text);
      },
      end(finish) {
        done = true;
        truncated = truncated || limits.includes(finish);
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
        idle: idle,
        signal: signal,
        onEvent(data) {
          // The line a Chat Completions stream closes with; nothing else outside JSON carries meaning.
          if (data === '[DONE]') return answer.end();
          let event;
          try {
            event = JSON.parse(data);
          } catch (_) {
            return;
          }
          if (event && typeof event === 'object') protocol.event(event, answer);
        }
      });
      if (!reply.streamed) {
        // A gateway that does not stream answers the same request in one piece.
        const whole = protocol.whole(reply.data || {});
        return { text: whole.text, truncated: limits.includes(whole.finish) };
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
    return { text: text, truncated: truncated };
  }

  return { request: request, generate: generate };
})();
