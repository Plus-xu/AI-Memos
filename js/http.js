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
  function unanswered(error) {
    var result = failure(0, error && error.name === 'TimeoutError' ? 'timeout' : 'error');
    result.cause = error;
    return result;
  }

  /** Resolves with the parsed answer; `body`, when given, is sent as JSON. `timeout` is in milliseconds. */
  async function json({ url, method = 'GET', headers = {}, body, timeout = 30000 }) {
    let response, text;
    try {
      response = await fetch(url, {
        method: method,
        headers: Object.assign(
          { Accept: 'application/json' },
          body === undefined ? {} : { 'Content-Type': 'application/json' },
          headers
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        signal: AbortSignal.timeout(timeout)
      });
      text = await response.text();
    } catch (error) {
      throw unanswered(error);
    }
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

  return { json: json };
})();
