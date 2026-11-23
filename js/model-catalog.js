/* global DraftStorage, LLM_CONFIG */
/* exported ModelCatalog */
/** Per-credential model catalogs. Only model names are persisted, never keys or endpoints in clear cache keys. */
var ModelCatalog = (function () {
  const accounts = new Map(),
    requests = new Map();
  const loaded = new Map();
  function gateway(base) {
    let url;
    try {
      url = new URL(base);
    } catch (error) {
      throw new Error('modelGatewayUrl', { cause: error });
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('modelGatewayUrl');
    let path = url.pathname.replace(/\/+$/, '');
    if (!path) path = '/v1';
    return url.origin + path;
  }

  function request(provider, config) {
    const item = LLM_CONFIG.providers[provider];
    const url = item.requiresBaseUrl ? gateway(config.baseUrl) + '/models' : item.modelsUrl;
    const key = (config.apiKey || '').trim();
    if (!key) throw new Error('aiApiKeyRequired');
    const headers = { Accept: 'application/json' };
    if (provider === 'gemini') headers['x-goog-api-key'] = key;
    else if (provider === 'anthropic')
      Object.assign(headers, {
        'x-api-key': key,
        'anthropic-version': item.anthropicVersion,
        'anthropic-dangerous-direct-browser-access': 'true'
      });
    else headers.Authorization = 'Bearer ' + key;
    return { url, headers, key };
  }

  async function fingerprint(provider, req) {
    const bytes = new TextEncoder().encode(JSON.stringify([provider, req.url, req.key]));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return 'memosModels-' + Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
  }

  function list(provider) {
    return loaded.get(provider) || [];
  }
  function nextRequest(provider) {
    const token = (requests.get(provider) || 0) + 1;
    requests.set(provider, token);
    return token;
  }
  function invalidate(provider) {
    nextRequest(provider);
    accounts.delete(provider);
    loaded.delete(provider);
  }

  async function restore(provider, config) {
    let req;
    try {
      req = request(provider, config);
    } catch (_) {
      invalidate(provider);
      return;
    }
    const token = nextRequest(provider),
      id = await fingerprint(provider, req);
    if (requests.get(provider) !== token) return;
    if (accounts.get(provider) !== id) loaded.delete(provider);
    accounts.set(provider, id);
    const saved = await DraftStorage.get('local', { [id]: [] });
    if (requests.get(provider) === token && accounts.get(provider) === id)
      loaded.set(provider, Array.isArray(saved[id]) ? saved[id] : []);
  }

  async function refresh(provider, config) {
    const req = request(provider, config);
    const generation = nextRequest(provider),
      id = await fingerprint(provider, req);
    if (requests.get(provider) === generation) {
      if (accounts.get(provider) !== id) loaded.delete(provider);
      accounts.set(provider, id);
    }
    const next = new URL(req.url);
    const models = new Set(),
      seen = new Set();
    while (true) {
      const response = await fetch(next, {
        headers: req.headers,
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw Object.assign(new Error('modelInvalid'), { status: response.status });
      const page = await response.json();
      const rows = provider === 'gemini' ? page.models : page.data;
      if (!Array.isArray(rows)) throw new Error('modelInvalid');
      for (const row of rows) {
        if (provider === 'gemini' && !row.supportedGenerationMethods?.includes('generateContent')) continue;
        const value = provider === 'gemini' ? row.name?.replace(/^models\//, '') : row.id;
        if (
          typeof value === 'string' &&
          value.trim() &&
          value.length <= 200 &&
          // eslint-disable-next-line no-control-regex -- model ids with control characters are rejected on purpose
          !/[\x00-\x1f]/.test(value) &&
          !/(?:^|[-_/])(?:embed(?:ding)?|realtime|audio|image|tts|asr|ocr|rerank|transcribe|moderation|whisper|sora|dall-e|imagen|veo|lyria|live|video)(?:[-_/.\d]|$)/i.test(
            value
          )
        )
          models.add(value);
      }
      const token =
        provider === 'gemini' ? page.nextPageToken : provider === 'anthropic' && page.has_more ? page.last_id : '';
      if (!token) {
        if (provider === 'anthropic' && page.has_more) throw new Error('modelInvalid');
        break;
      }
      if (seen.has(token)) throw new Error('modelInvalid');
      seen.add(token);
      next.searchParams.set(provider === 'gemini' ? 'pageToken' : 'after_id', token);
    }
    const values = Array.from(models).sort();
    if (requests.get(provider) === generation && accounts.get(provider) === id) {
      await DraftStorage.put('local', { [id]: values });
      if (requests.get(provider) === generation) loaded.set(provider, values);
    }
    return values.length;
  }

  return { gateway, list, restore, refresh, invalidate };
})();
