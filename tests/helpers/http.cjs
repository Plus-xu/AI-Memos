/**
 * The server side of js/http.js for tests. A test describes a server as responder(options): what it
 * returns is the JSON answer, and what it throws is the failure, in the shape the scripts read it
 * ({ status, statusText, responseJSON, getResponseHeader }). These helpers turn that into what fetch gives.
 */

/** A response with just what js/http.js reads; it settles within microtasks, unlike a streamed Response. */
function reply(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers(headers),
    text: async () => body
  };
}

const json = { 'Content-Type': 'application/json' };

/** The response for an answer. A responder that returns nothing answers null. */
const answered = data => reply(200, JSON.stringify(data === undefined ? null : data), json);

/**
 * The response for a described failure, or the rejection fetch would give: a timeout, or a network error
 * when there is no status. An Error is rethrown as it is, so a failed assertion in a responder stays visible
 * as the cause of the request's failure.
 */
function failed(failure) {
  if (!failure || typeof failure !== 'object' || failure instanceof Error) throw failure;
  if (failure.statusText === 'timeout')
    throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
  if (!failure.status) throw new TypeError('Failed to fetch');
  if (failure.responseJSON !== undefined) return reply(failure.status, JSON.stringify(failure.responseJSON), json);
  const type = failure.getResponseHeader?.('Content-Type');
  return reply(failure.status, type ? '<!doctype html><title>Memos</title>' : '', type ? { 'Content-Type': type } : {});
}

/** A request as responders see it: the address, the method as `type`, the body text as `data`, the headers. */
const optionsOf = (url, init = {}) => ({
  url: String(url),
  type: init.method || 'GET',
  data: init.body,
  headers: init.headers || {}
});

/** A fetch answered by responder(options); every request is also pushed onto `calls`. */
function serverFetch(responder, calls = []) {
  return async (url, init) => {
    const options = optionsOf(url, init);
    calls.push(options);
    await null;
    let data;
    try {
      data = await responder(options);
    } catch (failure) {
      return failed(failure);
    }
    return answered(data);
  };
}

/**
 * A fetch whose requests wait for the test: each is pushed onto `requests` with success(data) and
 * error(failure) to answer it.
 */
function pendingFetch(requests) {
  return (url, init) =>
    new Promise((resolve, reject) => {
      requests.push({
        ...optionsOf(url, init),
        success: data => resolve(answered(data)),
        error: failure => {
          try {
            resolve(failed(failure));
          } catch (rejection) {
            reject(rejection);
          }
        }
      });
    });
}

/**
 * A fetch whose answers are event streams the test writes. Each request is pushed onto `requests` with
 * send(chunk) to deliver text or bytes, end() to finish the stream and fail(error) to break it. As with a
 * real fetch, aborting the request's signal rejects before the answer and breaks the stream after it.
 */
function streamingFetch(requests, { status = 200, type = 'text/event-stream' } = {}) {
  const encoder = new TextEncoder();
  const aborted = () => new DOMException('The operation was aborted.', 'AbortError');
  return async (url, init = {}) => {
    if (init.signal?.aborted) throw aborted();
    let controller,
      open = true;
    const body = new ReadableStream({
      start(value) {
        controller = value;
      }
    });
    const settle = action => {
      if (open) action();
      open = false;
    };
    const fail = error => settle(() => controller.error(error));
    init.signal?.addEventListener('abort', () => fail(aborted()), { once: true });
    requests.push({
      ...optionsOf(url, init),
      send: chunk => {
        if (open) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      },
      end: () => settle(() => controller.close()),
      fail
    });
    return new Response(body, { status, headers: { 'Content-Type': type } });
  };
}

module.exports = { serverFetch, pendingFetch, streamingFetch };
