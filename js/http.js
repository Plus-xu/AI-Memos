/* exported Http */
/**
 * JSON requests over fetch. A failure is an object with the fields its callers read from the jqXHR
 * they were written for: status, statusText, responseJSON and getResponseHeader(name).
 */
var Http = (function () {
  function failure(status, statusText, response, responseJSON) {
    return {
      status: status,
      statusText: statusText,
      responseJSON: responseJSON,
      getResponseHeader: function (name) {
        return response ? response.headers.get(name) : null;
      }
    };
  }

  // Status 0 means no answer arrived: the request may or may not have reached the server.
  function unanswered(error, statusText) {
    var result = failure(0, statusText || (error && error.name === 'TimeoutError' ? 'timeout' : 'error'));
    result.cause = error;
    return result;
  }

  async function send(accept, url, method, headers, body, signal) {
    return fetch(url, {
      method: method,
      // The content type is declared on every request, with or without a body, as it always was.
      headers: Object.assign({ Accept: accept, 'Content-Type': 'application/json' }, headers),
      body: body === undefined ? undefined : JSON.stringify(body),
      // From an extension page with host permissions this sends the site's cookies, as XMLHttpRequest
      // did: a server behind a cookie-session access proxy depends on them.
      credentials: 'same-origin',
      signal: signal
    });
  }

  /** The data of an answer read to its end, or the failure its status or its text makes of it. */
  function answered(response, text) {
    let data,
      parsed = false;
    try {
      if (text) {
        data = JSON.parse(text);
        parsed = true;
      }
    } catch (_) {
      /* not JSON: the status decides below */
    }
    if (!response.ok)
      throw failure(response.status, response.statusText || 'error', response, parsed ? data : undefined);
    if (response.status === 204) return undefined;
    // An older server answers an unknown API route with its web page.
    if (!parsed) throw failure(response.status, 'parsererror', response);
    return data;
  }

  /** Resolves with the parsed answer; `body`, when given, is sent as JSON. `timeout` is in milliseconds. */
  async function json({ url, method = 'GET', headers = {}, body, timeout = 30000 }) {
    let response, text;
    // Only the time limit aborts this signal, whatever name the browser gives the resulting error.
    const signal = AbortSignal.timeout(timeout);
    try {
      response = await send('application/json', url, method, headers, body, signal);
      text = await response.text();
    } catch (error) {
      throw unanswered(error, signal.aborted && 'timeout');
    }
    return answered(response, text);
  }

  /** Reads an answer as text: each call resolves with the piece that arrived, and with null after the last. */
  function pieces(response) {
    // An answer without content, such as a 204, has no body to read from.
    const reader = response.body ? response.body.getReader() : null;
    const decoder = new TextDecoder();
    let done = false;
    return async function () {
      if (done) return null;
      if (!reader) {
        done = true;
        return response.text();
      }
      const chunk = await reader.read();
      if (!chunk.done) return decoder.decode(chunk.value, { stream: true });
      done = true;
      // What is left of a character the answer ended in the middle of.
      return decoder.decode();
    };
  }

  /** Cuts the text of an event stream into events: onEvent(data, name) for each one that carries data. */
  function eventReader(onEvent) {
    var pending = '',
      afterReturn = false,
      data = [],
      name = '';

    function line(text) {
      if (!text) {
        if (data.length) onEvent(data.join('\n'), name || 'message');
        data = [];
        name = '';
        return;
      }
      var colon = text.indexOf(':');
      var field = colon < 0 ? text : text.slice(0, colon);
      var value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'event') name = value;
    }

    return {
      push: function (text) {
        if (!text) return;
        // The line feed of a pair whose carriage return ended the piece before.
        if (afterReturn && text.charAt(0) === '\n') text = text.slice(1);
        afterReturn = text.endsWith('\r');
        var lines = (pending + text).split(/\r\n|\r|\n/);
        pending = lines.pop();
        lines.forEach(line);
      },
      // A server may close the stream without the blank line that ends its last event.
      end: function () {
        if (pending) line(pending);
        pending = '';
        line('');
      }
    };
  }

  /**
   * Whether an answer that starts with `text` is an event stream: true, false, or null while its first
   * characters do not tell yet. A gateway may label either kind as the other, but no event stream starts
   * the way JSON does, and no JSON the way an event stream does.
   */
  function startsEvents(text, labelled) {
    const start = text.trimStart();
    if (start.charAt(0) === '{' || start.charAt(0) === '[') return false;
    if (labelled) return start ? true : null;
    return /^(?:data|event|id|retry)?:/.test(start) ? true : null;
  }

  /**
   * Sends `body` as JSON and reads the answer while it arrives. An event stream is handed to
   * onEvent(data, name) one event at a time and resolves { streamed: true }. Any other answer is read
   * to its end and resolves { streamed: false, data } as json() would, since not every gateway streams.
   * Which of the two an answer is shows in how it starts, not in what it is labelled as.
   *
   * `idle` is the longest silence allowed, in milliseconds, before the answer and between its pieces.
   * `signal` lets the caller stop, which fails with the status text "abort". A failure in the middle of
   * a stream is thrown like any other; the events already delivered stand.
   */
  async function stream({ url, method = 'POST', headers = {}, body, idle = 90000, signal, onEvent }) {
    const control = new AbortController();
    let timedOut = false,
      heard = Date.now(),
      timer;
    // One timer serves the whole request: when it fires, it waits out what is left of the silence.
    const watch = () => {
      const left = idle - (Date.now() - heard);
      if (left > 0) timer = setTimeout(watch, left);
      else {
        timedOut = true;
        control.abort();
      }
    };
    const stop = () => control.abort();
    // Whatever error the browser raises for it, the cause is the one that aborted the request.
    const lost = error => {
      throw unanswered(error, timedOut ? 'timeout' : signal && signal.aborted ? 'abort' : '');
    };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    timer = setTimeout(watch, idle);
    try {
      const accept = 'text/event-stream, application/json';
      const response = await send(accept, url, method, headers, body, control.signal).catch(lost);
      heard = Date.now();
      const events = eventReader(onEvent);
      const next = pieces(response);
      const labelled = response.ok && /^text\/event-stream\b/i.test(response.headers.get('Content-Type') || '');
      // Whether the answer is delivered as events: open until its first characters show what it is.
      // A refusal is read whole, whatever it is labelled as or looks like.
      let live = response.ok ? null : false;
      let text = '';
      for (;;) {
        const piece = await next().catch(lost);
        heard = Date.now();
        if (piece === null) break;
        text += piece;
        if (live === null) live = startsEvents(text, labelled);
        if (live) {
          events.push(text);
          text = '';
        }
      }
      // An answer that never showed what it is, such as an empty one, is what it was labelled as.
      if (live === null) live = labelled;
      if (!live) return { streamed: false, data: answered(response, text) };
      events.end();
      return { streamed: true };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', stop);
      // Releases the connection when onEvent threw in the middle of the stream.
      control.abort();
    }
  }

  return { json: json, stream: stream };
})();
