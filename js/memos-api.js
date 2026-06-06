/**
 * Memos API compatibility helpers.
 * Supports current Memos API first, with narrow fallbacks for v0.25.x.
 */

const MemosAPI = (function () {
  function normalizeBaseUrl(apiUrl) {
    var value = (apiUrl || '').trim();
    if (value && !value.endsWith('/')) {
      value += '/';
    }
    return value;
  }

  function request(info, options) {
    return $.ajax({
      url: normalizeBaseUrl(info.apiUrl) + options.path,
      type: options.method || 'GET',
      data: options.body ? JSON.stringify(options.body) : undefined,
      contentType: 'application/json',
      dataType: 'json',
      headers: {
        'Authorization': 'Bearer ' + info.apiTokens
      }
    });
  }

  function currentUser(apiUrl, apiTokens) {
    var info = { apiUrl: normalizeBaseUrl(apiUrl), apiTokens: apiTokens };
    return request(info, {
      path: 'api/v1/auth/me'
    }).catch(function () {
      return request(info, {
        path: 'api/v1/auth/sessions/current'
      });
    }).then(function (response) {
      var user = response.user || response;
      var userName = user.name || response.name || '';
      if (!userName) {
        throw new Error('missing_user_name');
      }
      return {
        raw: response,
        userName: userName,
        userId: userName.split('/').pop()
      };
    });
  }

  function listMemos(info, query) {
    return request(info, {
      path: 'api/v1/memos' + (query || '')
    }).then(function (data) {
      return data.memos || data.items || [];
    });
  }

  function listShortcuts(info, parent) {
    var parentName = String(parent || '').trim();
    if (!parentName) {
      parentName = info.userName || info.userid || info.userId || 'me';
    }
    if (parentName.slice(0, 6) !== 'users/') {
      parentName = 'users/' + parentName;
    }

    return request(info, {
      path: 'api/v1/' + parentName.split('/').map(encodeURIComponent).join('/') + '/shortcuts'
    }).then(function (data) {
      return data.shortcuts || data.items || [];
    });
  }

  function getMemo(info, memoName) {
    return request(info, {
      path: 'api/v1/' + memoName
    });
  }

  function createMemo(info, body) {
    return request(info, {
      path: 'api/v1/memos',
      method: 'POST',
      body: body
    });
  }

  function archiveMemo(info, memoName) {
    return request(info, {
      path: 'api/v1/' + memoName + '?updateMask=state',
      method: 'PATCH',
      body: { state: 'ARCHIVED' }
    }).catch(function () {
      return request(info, {
        path: 'api/v1/' + memoName,
        method: 'PATCH',
        body: {
          state: 'ARCHIVED',
          updateMask: ['state']
        }
      });
    });
  }

  function uploadAttachment(info, body) {
    return request(info, {
      path: 'api/v1/attachments',
      method: 'POST',
      body: body
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

  function buildFileUrl(apiUrl, attachment) {
    if (!attachment) return '';
    if (attachment.externalLink) return attachment.externalLink;

    var fileId = attachment.publicId || attachment.filename || (attachment.name || '').split('/').pop();
    if (!attachment.name || !fileId) return '';
    return normalizeBaseUrl(apiUrl) + 'file/' + attachment.name + '/' + fileId;
  }

  return {
    normalizeBaseUrl: normalizeBaseUrl,
    currentUser: currentUser,
    listMemos: listMemos,
    listShortcuts: listShortcuts,
    getMemo: getMemo,
    createMemo: createMemo,
    archiveMemo: archiveMemo,
    uploadAttachment: uploadAttachment,
    getMemoId: getMemoId,
    getMemoPageId: getMemoPageId,
    getMemoAttachments: getMemoAttachments,
    buildMemoUrl: buildMemoUrl,
    buildFileUrl: buildFileUrl
  };
})();
