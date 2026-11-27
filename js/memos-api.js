/* global DraftStorage, Http */
/* exported MemosAPI */
/**
 * Memos API compatibility helpers.
 * Uses the unversioned API in Memos 26.10+ and detects older /api/v1 servers.
 */

const MemosAPI = (function () {
  var apiPrefixes = new Map();
  var remembered = null;

  // Local storage remembers the servers that need 'api/v1/'; every other server starts at 'api/'.
  function legacyServers(stored) {
    return stored && typeof stored === 'object' ? stored : {};
  }

  function knownPrefix(baseUrl) {
    if (apiPrefixes.has(baseUrl)) return Promise.resolve(apiPrefixes.get(baseUrl));
    if (!remembered)
      remembered = DraftStorage.get('local', { memosApiPrefixes: {} }).then(
        function (items) {
          return legacyServers(items.memosApiPrefixes);
        },
        function () {
          return {};
        }
      );
    return remembered.then(function (servers) {
      return apiPrefixes.get(baseUrl) || (servers[baseUrl] === 'api/v1/' ? 'api/v1/' : 'api/');
    });
  }

  // A failure to remember costs one probe on the next page; it never fails the request.
  function rememberPrefix(baseUrl, prefix) {
    return DraftStorage.locked('memos-api-prefixes', async function () {
      var servers = legacyServers((await DraftStorage.get('local', { memosApiPrefixes: {} })).memosApiPrefixes);
      if (prefix === 'api/v1/') servers[baseUrl] = prefix;
      else delete servers[baseUrl];
      await DraftStorage.put('local', { memosApiPrefixes: servers });
    }).catch(function () {});
  }

  function normalizeBaseUrl(apiUrl) {
    var value = String(apiUrl || '')
      .trim()
      .replace(/\/+$/, '');
    return value ? value + '/' : '';
  }

  function apiError(code, status) {
    var error = new Error(code);
    error.code = code;
    error.status = status || 0;
    return error;
  }

  function isValidBaseUrl(apiUrl) {
    try {
      var url = new URL(apiUrl);
      return (
        /^https?:$/.test(url.protocol) && !!url.hostname && !url.username && !url.password && !url.search && !url.hash
      );
    } catch (_) {
      return false;
    }
  }

  function isMissingRoute(xhr) {
    if (!xhr) return false;
    if (xhr.status === 404 || xhr.status === 410) return true;
    // Older servers can serve their SPA instead of an unknown API route.
    return (
      xhr.status === 200 && xhr.getResponseHeader && /text\/html/i.test(xhr.getResponseHeader('Content-Type') || '')
    );
  }

  function rawRequest(info, prefix, options) {
    options.checkDestination?.(info);
    return Http.json({
      url: normalizeBaseUrl(info.apiUrl) + prefix + options.path,
      method: options.method || 'GET',
      body: options.body,
      timeout: 30000,
      headers: { Authorization: 'Bearer ' + String(info.apiTokens || '').trim() }
    });
  }

  function request(info, options) {
    var baseUrl = normalizeBaseUrl(info.apiUrl);
    if (!isValidBaseUrl(baseUrl)) return Promise.reject(apiError('invalid_url'));

    return knownPrefix(baseUrl).then(function (known) {
      var prefix = known;
      return rawRequest(info, prefix, options)
        .catch(function (xhr) {
          // Only a missing route can be retried. Never replay an uncertain write,
          // authentication failure, quota refusal, timeout, or server error.
          if (!isMissingRoute(xhr)) throw xhr;
          prefix = prefix === 'api/' ? 'api/v1/' : 'api/';
          return rawRequest(info, prefix, options);
        })
        .then(function (data) {
          apiPrefixes.set(baseUrl, prefix);
          if (prefix === known) return data;
          return rememberPrefix(baseUrl, prefix).then(function () {
            return data;
          });
        });
    });
  }

  function getInstanceProfile(info) {
    return request(info, { path: 'instance/profile' }).then(function (data) {
      if (!data || typeof data.version !== 'string' || !data.version.trim()) {
        throw apiError('invalid_response');
      }
      return { version: data.version.trim() };
    });
  }

  function currentUser(apiUrl, apiTokens) {
    var info = { apiUrl: normalizeBaseUrl(apiUrl), apiTokens: apiTokens };
    return request(info, {
      path: 'auth/me'
    })
      .catch(function (xhr) {
        if (!isMissingRoute(xhr)) throw xhr;
        return request(info, {
          path: 'auth/sessions/current'
        });
      })
      .then(function (response) {
        if (!response) throw apiError('invalid_response');
        var user = response.user || response;
        var userName = user.name || response.name || '';
        if (typeof userName !== 'string' || !/^users\/[^/]+$/.test(userName)) {
          throw apiError('invalid_response');
        }
        return {
          raw: response,
          userName: userName,
          userId: userName.split('/').pop()
        };
      });
  }

  async function listMemoPage(info, query) {
    const params = new URLSearchParams(String(query || '').replace(/^\?/, ''));
    if (!params.has('pageSize')) params.set('pageSize', '25');
    const response = await request(info, { path: 'memos?' + params });
    const memos = response?.memos || response?.items || [];
    const next = response?.nextPageToken || response?.next_page_token || '';
    if (!response || !Array.isArray(memos) || typeof next !== 'string') throw apiError('invalid_response');
    return { memos, next };
  }

  async function listSpaces(info) {
    // Spaces came after the unversioned API, so a server that needs 'api/v1/' has none.
    if ((await knownPrefix(normalizeBaseUrl(info.apiUrl))) === 'api/v1/') return [];
    let token = '';
    const seen = new Set(),
      spaces = [];
    do {
      const query = new URLSearchParams({ pageSize: '100' });
      if (token) query.set('pageToken', token);
      const response = await request(info, { path: 'spaces?' + query });
      if (!response || (response.spaces && !Array.isArray(response.spaces))) throw apiError('invalid_response');
      spaces.push(...(response.spaces || []).filter(space => /^spaces\/[^/]+$/.test(space.name)));
      token = response.nextPageToken || '';
      if (token && (typeof token !== 'string' || seen.has(token))) throw apiError('invalid_page_token');
      seen.add(token);
    } while (token);
    return spaces;
  }

  function listMemos(info, query) {
    var params = new URLSearchParams(String(query || '').replace(/^\?/, ''));
    if (!params.has('pageSize')) params.set('pageSize', '1000');
    var memos = [];
    var memoNames = new Set();
    var pageTokens = new Set();
    if (params.get('pageToken')) pageTokens.add(params.get('pageToken'));

    function nextPage() {
      return request(info, { path: 'memos?' + params.toString() }).then(function (data) {
        var page = data && (data.memos || data.items || []);
        if (!Array.isArray(page)) throw apiError('invalid_response');
        page.forEach(function (memo) {
          if (!memo.name || !memoNames.has(memo.name)) {
            memos.push(memo);
            if (memo.name) memoNames.add(memo.name);
          }
        });
        var token = data.nextPageToken || data.next_page_token || '';
        if (!token) return memos;
        if (typeof token !== 'string' || pageTokens.has(token)) {
          throw apiError('invalid_page_token');
        }
        pageTokens.add(token);
        params.set('pageToken', token);
        return nextPage();
      });
    }
    return nextPage();
  }

  // The tags of the user's own memos, or null when the server has no statistics to read them from.
  function userTags(info) {
    var user = /^users\/([^/]+)$/.exec(info.userName || '');
    if (!user) return Promise.resolve(null);
    return request(info, { path: 'users/' + encodeURIComponent(user[1]) + ':getStats' }).then(
      function (stats) {
        var counts = stats && (stats.tagCounts || stats.tagCount);
        if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
        return Object.keys(counts).filter(function (tag) {
          return counts[tag] > 0;
        });
      },
      function (xhr) {
        if (isMissingRoute(xhr) || [400, 405, 501].includes(xhr && xhr.status)) return null;
        throw xhr;
      }
    );
  }

  // The largest attachment the server takes from this user, in bytes, or null when it does not say.
  function uploadLimit(info) {
    var user = /^users\/([^/]+)$/.exec(info.userName || '');
    if (!user) return Promise.resolve(null);
    return request(info, { path: 'users/' + encodeURIComponent(user[1]) + '/usage' }).then(
      function (usage) {
        var value = usage && usage.limits && usage.limits.uploadBytes;
        var bytes = /^\d+$/.test(String(value)) ? Number(value) : 0;
        return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
      },
      function (xhr) {
        if (isMissingRoute(xhr) || [400, 405, 501].includes(xhr && xhr.status)) return null;
        throw xhr;
      }
    );
  }

  function buildContentFilter(pattern) {
    return 'content.contains(' + JSON.stringify(String(pattern)) + ')';
  }

  function getMemo(info, memoName) {
    return request(info, {
      path: memoName
    });
  }

  function createMemo(info, body, memoId, checkDestination) {
    return request(info, {
      path: 'memos' + (memoId ? '?memoId=' + encodeURIComponent(memoId) : ''),
      method: 'POST',
      body: body,
      checkDestination
    });
  }

  function archiveMemo(info, memoName) {
    return patchMemo(info, memoName, 'state', 'ARCHIVED');
  }

  function restoreMemo(info, memoName) {
    return patchMemo(info, memoName, 'state', 'NORMAL');
  }

  function patchMemo(info, memoName, field, value) {
    return request(info, {
      path: memoName + '?updateMask=' + field,
      method: 'PATCH',
      body: { [field]: value }
    });
  }

  function setMemoVisibility(info, memoName, visibility) {
    return patchMemo(info, memoName, 'visibility', visibility);
  }

  function uploadAttachment(info, body, checkDestination) {
    return request(info, {
      path: 'attachments',
      method: 'POST',
      body: { filename: body.filename, type: body.type, content: body.content },
      checkDestination
    });
  }

  function getMemoId(memo) {
    if (!memo || !memo.name) return '';
    return memo.name.split('/').pop();
  }

  function getMemoPageId(memo) {
    if (!memo) return '';
    var memoId = getMemoId(memo);
    if (memoId) return memoId;
    if (memo.uid !== undefined && memo.uid !== null && memo.uid !== '') return String(memo.uid);
    if (memo.id !== undefined && memo.id !== null && memo.id !== '') return String(memo.id);
    return '';
  }

  function buildMemoUrl(apiUrl, memo) {
    var memoPageId = getMemoPageId(memo);
    if (!memoPageId) return normalizeBaseUrl(apiUrl);
    return normalizeBaseUrl(apiUrl) + 'memos/' + encodeURIComponent(memoPageId);
  }

  function getMemoAttachments(memo) {
    if (!memo) return [];
    return memo.attachments || memo.resources || [];
  }

  function encodePathSegment(value) {
    return encodeURIComponent(value).replace(/[!'()*]/g, function (character) {
      return '%' + character.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function buildFileUrl(apiUrl, attachment) {
    if (!attachment) return '';
    if (attachment.externalLink) return attachment.externalLink;

    var fileId = attachment.publicId || attachment.filename || (attachment.name || '').split('/').pop();
    if (!attachment.name || !fileId) return '';
    return (
      normalizeBaseUrl(apiUrl) +
      'file/' +
      attachment.name.split('/').map(encodePathSegment).join('/') +
      '/' +
      encodePathSegment(fileId)
    );
  }

  function managedFile(apiUrl, value) {
    try {
      var base = new URL(normalizeBaseUrl(apiUrl));
      var raw = String(value || '');
      var url = new URL(raw.replace(/^\/?file\//, base.href + 'file/'), base);
      var prefix = base.pathname + 'file/attachments/';
      if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || url.search || url.hash) return null;
      var segments = url.pathname.slice(prefix.length).split('/');
      var [id, filename] = segments;
      if (segments.length > 2 || !/^[a-zA-Z0-9_-]+$/.test(id) || filename === '') return null;
      return {
        name: 'attachments/' + id,
        filename: filename ? decodeURIComponent(filename) : '',
        url: url.href,
        path: '/file/attachments/' + segments.join('/')
      };
    } catch (_) {
      return null;
    }
  }

  // Only generated inline links are rewritten. Leave Markdown code examples,
  // external images, and links to already-bound files unchanged.
  function mapMarkdownLinks(content, transform) {
    return formatMarkdownLinks(content, ({ image, label, url, angle, title }) => {
      const replacement = transform(url, image);
      return (image ? '!' : '') + '[' + label + '](' + (angle ? '<' + replacement + '>' : replacement) + title + ')';
    });
  }

  const labelChar = /(?:\\.|[^\\[\]\r\n])/.source;
  const destination = /(?:<[^>\r\n]+>|[^\s)<][^\s)]*)/.source;
  const optionalTitle = /(?:[ \t]+(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'))?/.source;
  const imageInLabel = `!\\[${labelChar}*\\]\\(${destination}${optionalTitle}\\)`;
  const inlineMarkup = new RegExp(
    [
      /\\./.source,
      /(`+).*?\1/.source,
      `(!?)\\[((?:${imageInLabel}|${labelChar})*)\\]\\((${destination})(${optionalTitle})\\)`
    ].join('|'),
    'g'
  );

  // The save and preview paths read the same links. A link label may contain text and images.
  // An image receives its raw alt text. A link receives its label with the images already formatted.
  function formatMarkdownLinks(content, formatLink, formatText = text => text) {
    function inline(text, inLabel = false) {
      let result = '',
        end = 0;
      for (const match of text.matchAll(inlineMarkup)) {
        const [, , marker, rawLabel, destination, title] = match;
        if (marker === undefined) continue; // Escapes and code spans stay in the surrounding text.
        const image = marker === '!';
        const angle = destination.startsWith('<');
        result += formatText(text.slice(end, match.index), inLabel);
        result += formatLink({
          image,
          label: image ? rawLabel : inline(rawLabel, true),
          url: angle ? destination.slice(1, -1) : destination,
          angle,
          title
        });
        end = match.index + match[0].length;
      }
      return result + formatText(text.slice(end), inLabel);
    }

    let fence = null;
    // In opening order: '>' for a quote, or the spaces needed to continue a list item.
    const containers = [];
    const quoteMarker = /^ {0,3}> ?/;
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/;
    const listMarker = /^ {0,3}(?:[-+*]|\d{1,9}[.)])( +|$)/;
    return String(content)
      .split('\n')
      .map(function (line) {
        // Measure Markdown columns on a copy so literal tabs survive in the saved text.
        let extra = 0;
        let body = line.replace(/\r$/, '').replace(/\t/g, (_, index) => {
          const width = 4 - ((index + extra) % 4);
          extra += width - 1;
          return ' '.repeat(width);
        });
        let depth = 0;
        for (const container of containers) {
          if (container === '>') {
            const quote = body.match(quoteMarker);
            if (!quote) break;
            body = body.slice(quote[0].length);
          } else if (body.startsWith(container)) {
            body = body.slice(container.length);
          } else if (body.trim()) break;
          depth++;
        }
        if (depth < containers.length) {
          containers.length = depth;
          fence = null;
        }
        if (fence) {
          const close = body.match(fenceMarker);
          if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !close[2].trim()) fence = null;
          return formatText(line);
        }
        for (;;) {
          const quote = body.match(quoteMarker);
          if (quote) {
            containers.push('>');
            body = body.slice(quote[0].length);
            continue;
          }
          const item = body.match(listMarker);
          if (!item) break;
          const gap = item[1].length;
          const width = item[0].length - gap + (gap >= 1 && gap <= 4 ? gap : 1);
          containers.push(' '.repeat(width));
          body = body.slice(width);
        }
        if (body.startsWith('    ')) return formatText(line);
        const marker = body.match(fenceMarker);
        if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
          fence = marker[1];
          return formatText(line);
        }
        return inline(line);
      })
      .join('\n');
  }

  function normalizeMemoImages(info, content) {
    var canOmitFilename = apiPrefixes.get(normalizeBaseUrl(info.apiUrl)) === 'api/';
    return mapMarkdownLinks(content, function (url, image) {
      var file = image && managedFile(info.apiUrl, url);
      if (!file) return url;
      // Current Memos rejects encoded filenames in Markdown images and serves the attachment by ID.
      return canOmitFilename && file.path.includes('%') ? '/file/' + file.name : file.path;
    });
  }

  function prepareMemo(info, body) {
    var references = new Map();
    mapMarkdownLinks(body.content, function (url, image) {
      var file = managedFile(info.apiUrl, url);
      if (file) {
        var reference = references.get(file.name);
        references.set(file.name, { file: file, image: image || !!(reference && reference.image) });
      }
      return url;
    });

    return Promise.all(
      Array.from(references.values()).map(function (reference) {
        return request(info, { path: reference.file.name }).then(function (attachment) {
          if (!attachment || attachment.name !== reference.file.name) throw apiError('invalid_response');
          // Ordinary links can point at another memo's file. Managed images must
          // belong to this memo, so let the server validate an existing binding.
          reference.bind = !attachment.memo || reference.image;
          return reference;
        });
      })
    ).then(function (resolved) {
      var prepared = Object.assign({}, body);
      var attachments = resolved.filter(function (reference) {
        return reference.bind;
      });
      prepared.content = normalizeMemoImages(info, body.content);
      if (attachments.length) {
        prepared.attachments = attachments.map(function (reference) {
          return { name: reference.file.name };
        });
      }
      return prepared;
    });
  }

  function fetchAttachmentBlob(info, url, signal) {
    var file = managedFile(info.apiUrl, url);
    if (!file) return Promise.reject(apiError('invalid_attachment_url'));
    return fetch(file.url, {
      headers: { Authorization: 'Bearer ' + String(info.apiTokens || '').trim() },
      credentials: 'omit',
      redirect: 'error',
      signal: signal || AbortSignal.timeout(30000)
    }).then(function (response) {
      if (!response.ok) throw apiError('attachment_fetch_failed', response.status);
      return response.blob();
    });
  }

  return {
    normalizeBaseUrl: normalizeBaseUrl,
    getInstanceProfile: getInstanceProfile,
    currentUser: currentUser,
    listMemos,
    listMemoPage,
    listSpaces,
    userTags,
    uploadLimit,
    isMissingRoute,
    buildContentFilter: buildContentFilter,
    getMemo: getMemo,
    formatMarkdownLinks,
    normalizeMemoImages,
    prepareMemo: prepareMemo,
    createMemo: createMemo,
    archiveMemo: archiveMemo,
    restoreMemo: restoreMemo,
    setMemoVisibility: setMemoVisibility,
    uploadAttachment: uploadAttachment,
    getMemoId: getMemoId,
    getMemoPageId: getMemoPageId,
    getMemoAttachments: getMemoAttachments,
    buildMemoUrl: buildMemoUrl,
    buildFileUrl: buildFileUrl,
    managedFile: managedFile,
    fetchAttachmentBlob: fetchAttachmentBlob
  };
})();
