/* global AIReview, DraftEditor, DraftStorage, MemoIndex, MemoTags, MemosAPI, StagedFiles, Workspace, uiMessage */
/* exported resolveVisibility, clearMemoList, renderMemoList, appendMemoList, closeTagList, refreshSaveButton */
function relativeTime(value, lang, now) {
  var time = value === '' || value == null ? NaN : new Date(value).getTime();
  if (Number.isNaN(time)) return '';
  var seconds = Math.round((time - (now === undefined ? Date.now() : now)) / 1000);
  // The present, and a server clock running slightly ahead, both read as "now".
  if (seconds >= 0 && seconds < 60)
    return new Intl.RelativeTimeFormat(lang || 'en', { numeric: 'auto' }).format(0, 'second');
  var units = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
    ['year', Infinity]
  ];
  var amount = seconds;
  for (var i = 0; i < units.length; i++) {
    if (Math.abs(amount) < units[i][1])
      return new Intl.RelativeTimeFormat(lang || 'en').format(Math.trunc(amount), units[i][0]);
    amount /= units[i][1];
  }
}

var memoSaveInProgress = false;
var pendingUploads = 0;
// Private images downloaded for the results on screen, by account and attachment name.
var previewGeneration = 0;
var previewFiles = new Map();
var previewObjectUrls = new Set();
var previewController = null;

function get_info(callback) {
  chrome.storage.sync.get(
    {
      apiUrl: '',
      apiTokens: '',
      hidetag: '',
      showtag: '',
      memo_lock: '',
      userid: '',
      userName: '',
      memosVersion: ''
    },
    function (items) {
      var returnObject = {
        status: !!(items.apiUrl && items.apiTokens),
        apiUrl: MemosAPI.normalizeBaseUrl(items.apiUrl),
        apiTokens: items.apiTokens,
        hidetag: items.hidetag,
        showtag: items.showtag,
        memo_lock: items.memo_lock,
        userid: items.userid,
        userName: items.userName,
        memosVersion: items.memosVersion
      };

      if (callback) callback(returnObject);
    }
  );
}

function showApiError(prefix, xhr, fallbackMessage) {
  console.error(prefix, {
    status: xhr && xhr.status,
    statusText: xhr && xhr.statusText,
    code: xhr && xhr.code
  });

  var errorMsg = fallbackMessage || uiMessage('apiFailed') || 'API call failed';
  if (xhr && xhr.code === 'invalid_url') {
    errorMsg = uiMessage('invalidUrl');
  } else if (xhr && xhr.status === 401) {
    errorMsg = uiMessage('invalidToken');
  } else if (xhr && xhr.status === 403) {
    errorMsg = uiMessage('permissionDenied');
  } else if (xhr && (xhr.status === 404 || xhr.status === 410)) {
    errorMsg = uiMessage('apiNotFound');
  } else if (xhr && xhr.status === 413) {
    errorMsg = uiMessage('uploadTooLarge');
  } else if (xhr && xhr.status === 429) {
    var details = xhr.responseJSON && xhr.responseJSON.details;
    if (!Array.isArray(details)) details = [];
    var quota = details.some(function (detail) {
      return detail.reason === 'QUOTA_EXCEEDED';
    });
    errorMsg = uiMessage(quota ? 'quotaExceeded' : 'requestLimited');
  } else if (xhr && (xhr.statusText === 'timeout' || xhr.name === 'TimeoutError')) {
    errorMsg = uiMessage('apiTimeout');
  } else if (xhr && xhr.responseJSON && typeof xhr.responseJSON.message === 'string') {
    errorMsg += ': ' + xhr.responseJSON.message.slice(0, 240);
  }

  $.message({ message: errorMsg });
}

function resolveVisibility(info, content = $('textarea[name=text]').val()) {
  return MemoTags.visibility(content, info);
}

var exposedMemo = null;

// Second check: the server's own tag list decides whether the rule applied.
function checkSavedVisibility(info, memo) {
  var hidden = MemoTags.list(info.hidetag);
  var exposed =
    Array.isArray(memo.tags) &&
    memo.tags.some(function (tag) {
      return hidden.some(function (name) {
        return tag === name || String(tag).startsWith(name + '/');
      });
    }) &&
    typeof memo.visibility === 'string' &&
    memo.visibility !== 'PRIVATE';
  exposedMemo = exposed ? { name: memo.name, scope: DraftStorage.scope(info) } : null;
  $('#visibilityWarning').prop('hidden', !exposed);
}

async function makeSavedMemoPrivate() {
  var entry = exposedMemo;
  if (!entry) return;
  var info = await new Promise(function (resolve) {
    get_info(resolve);
  });
  function dismiss() {
    if (exposedMemo === entry) {
      exposedMemo = null;
      $('#visibilityWarning').prop('hidden', true);
    }
  }
  // The memo belongs to the account that saved it; never send its name to another one.
  if (DraftStorage.scope(info) !== entry.scope) {
    dismiss();
    return;
  }
  try {
    await MemosAPI.setMemoVisibility(info, entry.name, 'PRIVATE');
    dismiss();
    $.message({ message: uiMessage('madePrivate') });
  } catch (error) {
    showApiError('Make memo private', error, uiMessage('apiFailed'));
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function previewUrl(info, value) {
  var file = MemosAPI.managedFile(info.apiUrl, value);
  if (file) return file.url;
  try {
    var url = new URL(value, info.apiUrl);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function previewImage(info, value, label) {
  var url = previewUrl(info, value);
  if (!url) return escapeHtml(label || '');
  var source = MemosAPI.managedFile(info.apiUrl, url)
    ? ' data-memos-file="' + escapeHtml(url) + '" no-view'
    : ' src="' + escapeHtml(url) + '"';
  return '<img class="random-image" alt="' + escapeHtml(label || '') + '"' + source + ' referrerpolicy="no-referrer"/>';
}

function wrapPreviewLink(info, value, labelHtml) {
  var url = previewUrl(info, value);
  if (!url) return labelHtml;
  var file = MemosAPI.managedFile(info.apiUrl, url);
  var attributes = file ? ' class="memos-file-link" data-url="' + escapeHtml(url) + '"' : '';
  return (
    '<a href="' +
    escapeHtml(url) +
    '"' +
    attributes +
    ' target="_blank" rel="noreferrer noopener">' +
    labelHtml +
    '</a>'
  );
}

function renderMarkdownPreview(content, info) {
  const unescapeLabel = text => text.replace(/\\([\\[\]])/g, '$1');
  return MemosAPI.formatMarkdownLinks(
    content,
    ({ image, url, label }) =>
      image ? previewImage(info, url, unescapeLabel(label)) : wrapPreviewLink(info, url, label),
    (text, inLabel) => escapeHtml(inLabel ? unescapeLabel(text) : text)
  );
}

function releaseMemoPreviews() {
  previewGeneration++;
  if (previewController) previewController.abort();
  previewController = null;
  previewObjectUrls.forEach(function (url) {
    URL.revokeObjectURL(url);
  });
  previewObjectUrls.clear();
  previewFiles.clear();
}

function clearMemoList() {
  releaseMemoPreviews();
  $('#randomlist').html('').hide();
}

// Fills the images that have not been asked for yet; an image keeps data-memos-file until then.
function hydrateMemoImages(info) {
  var generation = previewGeneration;
  const scope = DraftStorage.scope(info);
  if (!previewController) previewController = new AbortController();
  var signal = previewController.signal;
  document.querySelectorAll('#randomlist img[data-memos-file]').forEach(function (element) {
    var url = element.getAttribute('data-memos-file');
    element.removeAttribute('data-memos-file');
    const file = MemosAPI.managedFile(info.apiUrl, url);
    if (!file) return;
    const key = scope + '/' + file.name;
    if (!previewFiles.has(key)) {
      var download = MemosAPI.fetchAttachmentBlob(info, url, signal).then(function (blob) {
        if (generation !== previewGeneration) return '';
        if (!blob.type.startsWith('image/')) throw new Error('invalid_image_response');
        var objectUrl = URL.createObjectURL(blob);
        previewObjectUrls.add(objectUrl);
        return objectUrl;
      });
      previewFiles.set(key, download);
      // A failed download is forgotten, so the next redraw asks again.
      download.catch(function () {
        if (previewFiles.get(key) === download) previewFiles.delete(key);
      });
    }
    previewFiles
      .get(key)
      .then(function (objectUrl) {
        if (!objectUrl || generation !== previewGeneration) return;
        element.src = objectUrl;
        element.removeAttribute('no-view');
      })
      .catch(function (error) {
        if (generation !== previewGeneration) return;
        element.alt = uiMessage('attachmentPreviewFailed');
        element.title = element.alt;
        console.error('Attachment preview failed', { status: error.status, code: error.code });
      });
  });
}

window.addEventListener('unload', releaseMemoPreviews);

function buildMemoAttachmentHtml(info, memo) {
  var html = '';
  var attachments = MemosAPI.getMemoAttachments(memo);

  for (var i = 0; i < attachments.length; i++) {
    var attachment = attachments[i];
    var type = attachment.type || '';
    var fileUrl = MemosAPI.buildFileUrl(info.apiUrl, attachment);
    var filename = attachment.filename || attachment.name || 'attachment';

    if (!fileUrl) continue;

    if (type.slice(0, 5) === 'image') {
      html += previewImage(info, fileUrl, filename);
    } else {
      html += wrapPreviewLink(info, fileUrl, escapeHtml(filename));
    }
  }

  return html;
}

function buildMemoHtml(info, memo) {
  var memoId = MemosAPI.getMemoId(memo);
  var memoUrl = MemosAPI.buildMemoUrl(info.apiUrl, memo);
  var createTime = memo.createTime || memo.createdTs || '';
  var timeText = relativeTime(createTime, document.documentElement.lang);

  var itemHtml = '<article class="random-item"><div class="random-time">' + escapeHtml(timeText);
  itemHtml +=
    '<button type="button" class="random-link" data-uid="' +
    escapeHtml(memoId) +
    '" data-url="' +
    escapeHtml(memoUrl) +
    '">' +
    escapeHtml(uiMessage('openSaved')) +
    '</button>';
  if (memo.creator === info.userName || !memo.creator)
    itemHtml +=
      '<button type="button" class="random-delete" data-name="' +
      escapeHtml(memo.name) +
      '">' +
      escapeHtml(uiMessage('archiveAction')) +
      '</button>';
  itemHtml += '</div><div class="random-content">' + renderMarkdownPreview(memo.content || '', info) + '</div>';
  itemHtml += buildMemoAttachmentHtml(info, memo);
  itemHtml += '</article>';

  return itemHtml;
}

function memoListHtml(info, memos) {
  var memoHtml = '';
  for (var i = 0; i < memos.length; i++) {
    memoHtml += buildMemoHtml(info, memos[i]);
  }
  return memoHtml;
}

// Redraws the results on screen. Their downloaded images are kept; clearMemoList() releases them.
function renderMemoList(info, memos) {
  $('#randomlist')
    .html(memoListHtml(info, memos))
    .toggle(memos.length > 0);
  hydrateMemoImages(info);
  window.ViewImage && ViewImage.init('.random-image:not(a img)');
}

// Adds a page of results below the ones on screen, which stay as they are.
function appendMemoList(info, memos) {
  $('#randomlist').append(memoListHtml(info, memos)).show();
  hydrateMemoImages(info);
  window.ViewImage && ViewImage.init('.random-image:not(a img)');
}

DraftStorage.load(function (draft) {
  const editor = document.getElementById('content');
  return DraftEditor.init(editor, draft).then(() => editor.focus());
}).catch(() => $.message({ message: uiMessage('draftSaveFailed') }));

function saveCurrentDraft() {
  Workspace.refreshVisibility();
  $('#saveStatus').prop('hidden', true);
  return DraftEditor.flush();
}

$('textarea[name=text]').on('input', saveCurrentDraft);
$('textarea[name=text]').on('keydown', function (event) {
  if (!event.isComposing && event.code === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    $('#content_submit_text').click();
  }
});

function add(text) {
  const editor = document.getElementById('content');
  if (memoSaveInProgress || editor.readOnly) return;
  const start = editor.selectionStart ?? editor.value.length;
  const end = editor.selectionEnd ?? start;
  editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
  editor.focus();
  editor.setSelectionRange(start + text.length, start + text.length);
  $('#content').trigger('input');
}

async function addFiles(files) {
  if (!files.length || memoSaveInProgress) return;
  pendingUploads++;
  try {
    let limit = await StagedFiles.limit();
    if (files.some(file => file.size > limit)) {
      // The remembered limit may have been raised on the server since: ask before refusing.
      const info = await new Promise(resolve => get_info(resolve));
      if (info.status) {
        await StagedFiles.refreshLimit(info, true);
        limit = await StagedFiles.limit();
      }
    }
    const references = [],
      refused = [];
    for (const file of files) {
      if (file.size > limit) refused.push(file.name || 'attachment');
      else references.push(await StagedFiles.stage(file, file.name, undefined, false, limit));
    }
    if (references.length) {
      add(references.join('\n'));
      await DraftEditor.flush();
    }
    // One message for the whole selection: a second one would replace the first on screen.
    if (refused.length)
      $.message({
        message: uiMessage('fileTooLarge')
          .replace('{limit}', (limit / 1048576).toFixed(1) + ' MB')
          .replace('{name}', () => refused.join(', ')),
        time: 6000
      });
    else $.message({ message: uiMessage('fileStaged') });
  } catch (_) {
    $.message({ message: uiMessage('picFailed') });
  } finally {
    pendingUploads--;
  }
}

document.addEventListener('paste', event => {
  if (event.target.id !== 'content' || !event.clipboardData?.files.length) return;
  event.preventDefault();
  addFiles(Array.from(event.clipboardData.files));
});
const memoEditor = document.getElementById('content');
memoEditor.ondragover = event => event.preventDefault();
memoEditor.ondrop = event => {
  if (event.dataTransfer.files.length) {
    event.preventDefault();
    addFiles(Array.from(event.dataTransfer.files));
  }
};
$('#newtodo').click(() => add('\n- [ ] '));
$('#upres').click(() => $('#inFile').click());
$('#inFile').on('change', function () {
  addFiles(Array.from(this.files));
  this.value = '';
});

$('#opensite').click(() =>
  get_info(info => {
    if (info.status) chrome.tabs.create({ url: info.apiUrl });
    else chrome.runtime.openOptionsPage();
  })
);
// The tag list is open from the click that asks for it, also while its tags are still loading.
var tagListOpen = false;
var tagListRun = 0;

function closeTagList() {
  tagListOpen = false;
  tagListRun++;
  $('#taglist').prop('hidden', true).html('');
}

function drawTagList(tags) {
  if (!tags.length) return closeTagList();
  var html = '';
  for (var i = 0; i < tags.length; i++)
    html += '<button type="button" class="item-container">' + escapeHtml('#' + tags[i]) + '</button>';
  $('#taglist').html(html);
}

// Redraws an open tag list after the index changed, unless a newer click has taken it over.
function refreshTagList(info) {
  if (!tagListOpen) return;
  var run = tagListRun;
  MemoIndex.tags(info).then(
    function (tags) {
      if (tagListOpen && run === tagListRun) drawTagList(tags);
    },
    function () {}
  );
}

$('#tags').click(() => {
  if (tagListOpen) {
    closeTagList();
    return;
  }
  tagListOpen = true;
  const run = ++tagListRun;
  const current = () => tagListOpen && run === tagListRun;
  $('#taglist')
    .html(escapeHtml(uiMessage('working')))
    .prop('hidden', false);
  get_info(async info => {
    if (!current()) return;
    if (!info.status) {
      closeTagList();
      $.message({ message: uiMessage('connectMemos') });
      return;
    }
    try {
      const tags = await MemoIndex.tags(info, fresh => {
        if (current()) drawTagList(fresh);
      });
      if (!current()) return;
      drawTagList(tags);
      if (!tags.length) $.message({ message: uiMessage('noTagsFound') });
    } catch (error) {
      if (!current()) return;
      closeTagList();
      showApiError('Tags', error, uiMessage('getTabFailed'));
    }
  });
});
$(document).on('click', '.item-container', function () {
  add($(this).text() + ' ');
});
$('#random').click(() =>
  get_info(async info => {
    if (!info.status) {
      $.message({ message: uiMessage('connectMemos') });
      return;
    }
    const run = Workspace.resetSearch();
    const current = () => run === Workspace.listRun();
    $('#searchStatus').text(uiMessage('working'));
    try {
      const memo = await randomMemo(info, current);
      if (!current()) return;
      $('#searchStatus').text(memo ? '' : uiMessage('noMemosFound'));
      if (memo) Workspace.show([memo]);
    } catch (error) {
      if (!current()) return;
      $('#searchStatus').text('');
      showApiError('Random memo', error, uiMessage('apiFailed'));
    }
  })
);

// Picks among the remembered memo names and fetches that one memo. A name whose memo is archived or gone
// is forgotten; after three of those in a row the names are listed again, once.
async function randomMemo(info, current) {
  for (const fresh of [false, true]) {
    const names = (await MemoIndex.names(info, fresh)).slice();
    for (let attempt = 0; attempt < 3 && names.length && current(); attempt++) {
      const name = names.splice(Math.floor(Math.random() * names.length), 1)[0];
      let memo = null;
      try {
        memo = await MemosAPI.getMemo(info, name);
      } catch (error) {
        if (!MemosAPI.isMissingRoute(error)) throw error;
      }
      if (memo && memo.name === name && memo.state !== 'ARCHIVED' && memo.rowStatus !== 'ARCHIVED') return memo;
      await MemoIndex.forget(info, name);
    }
    if (!current()) return null;
  }
  return null;
}

$(document).on('click', '.random-link', function () {
  var memoUrl = $(this).attr('data-url');
  var memoUid = $(this).attr('data-uid');
  get_info(function (info) {
    chrome.tabs.create({ url: memoUrl || info.apiUrl + 'memos/' + encodeURIComponent(memoUid) });
  });
});

var archivedEntry = null;
var archivingNames = new Set();

function dismissArchiveNotice() {
  archivedEntry = null;
  $('#archiveNotice').prop('hidden', true);
}

async function archiveMemoByName(name) {
  if (archivingNames.has(name)) return;
  archivingNames.add(name);
  var info;
  try {
    info = await new Promise(function (resolve) {
      get_info(resolve);
    });
    await MemosAPI.archiveMemo(info, name);
  } catch (xhr) {
    showApiError('Archive API failed', xhr, uiMessage('archiveFailed'));
    return;
  } finally {
    archivingNames.delete(name);
  }
  archivedEntry = { name: name, scope: DraftStorage.scope(info), removed: Workspace.remove(name) };
  $('#archiveNotice').prop('hidden', false);
  MemoIndex.archived(info, name);
}

async function undoArchive() {
  var entry = archivedEntry;
  if (!entry) return;
  var info = await new Promise(function (resolve) {
    get_info(resolve);
  });
  if (DraftStorage.scope(info) !== entry.scope) {
    if (archivedEntry === entry) dismissArchiveNotice();
    return;
  }
  try {
    await MemosAPI.restoreMemo(info, entry.name);
  } catch (xhr) {
    showApiError('Restore API failed', xhr, uiMessage('apiFailed'));
    return;
  }
  if (archivedEntry === entry) dismissArchiveNotice();
  Workspace.restore(entry.removed);
  MemoIndex.restored(info, entry.name);
  $.message({ message: uiMessage('archiveUndone') });
}

$(document).on('click', '.random-delete', function () {
  archiveMemoByName($(this).data('name'));
});
$('#archiveUndo').click(undoArchive);

$(document).on('click', '.memos-file-link', function (event) {
  event.preventDefault();
  var url = $(this).attr('data-url');
  get_info(function (info) {
    MemosAPI.fetchAttachmentBlob(info, url)
      .then(function (blob) {
        var objectUrl = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = objectUrl;
        link.download = MemosAPI.managedFile(info.apiUrl, url).filename;
        link.click();
        setTimeout(function () {
          URL.revokeObjectURL(objectUrl);
        }, 10000);
      })
      .catch(function (xhr) {
        showApiError('Attachment download failed', xhr, uiMessage('apiFailed'));
      });
  });
});

$('#content_submit_text').click(sendText);
$('#makePrivate').click(makeSavedMemoPrivate);

async function submitMemo(info, snapshot, selection) {
  const scope = DraftStorage.scope(info);
  const destination = await Workspace.destination(info, selection);
  const current = await DraftStorage.current();
  if (snapshot.open_content !== current.open_content || snapshot.revision !== current.revision)
    throw new Error('draftChanged');
  const original = snapshot.open_content;
  if (!info.memosVersion) {
    try {
      info.memosVersion = (await MemosAPI.getInstanceProfile(info)).version;
    } catch (_) {
      /* Version discovery is optional on legacy instances. */
    }
  }
  const modern = /^(\d+)\.(\d+)/.exec(info.memosVersion || '');
  const acceptsId = modern && (+modern[1] > 26 || (+modern[1] === 26 && +modern[2] >= 10));
  const input = new TextEncoder().encode(JSON.stringify([scope, original, destination]));
  const signature = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input)), b =>
    b.toString(16).padStart(2, '0')
  ).join('');
  const key = 'memosSaveAttempt:' + scope;
  const prior = (await DraftStorage.get('local', { [key]: null }))[key];
  selection.assertCurrent(info);
  const retry = prior?.signature === signature;
  const attemptId = retry ? prior.id : crypto.randomUUID();
  if (!retry) await DraftStorage.put('local', { [key]: { signature, id: attemptId } });
  const memoId = acceptsId ? attemptId : undefined;
  selection.assertCurrent(info);
  const content = await StagedFiles.resolve(info, original, attemptId, selection.assertCurrent);
  selection.assertCurrent(info);
  const body = await MemosAPI.prepareMemo(info, { content, ...destination });
  let memo;
  if (memoId && retry) {
    try {
      memo = await MemosAPI.getMemo(info, 'memos/' + memoId);
    } catch (error) {
      if (!MemosAPI.isMissingRoute(error)) throw error;
    }
    // An earlier extension could have saved the same linked image with an absolute URL.
    if (
      memo &&
      (memo.name !== 'memos/' + memoId ||
        typeof memo.content !== 'string' ||
        MemosAPI.normalizeMemoImages(info, memo.content) !== body.content)
    )
      throw new Error('unconfirmedSave');
  }
  if (!memo) {
    selection.assertCurrent(info);
    memo = await MemosAPI.createMemo(info, body, memoId);
  }
  if (!memo?.name || !/^memos\/[^/]+$/.test(memo.name)) throw new Error('unconfirmedSave');
  if (memoId && memo.name !== 'memos/' + memoId) throw new Error('unconfirmedSave');
  const sources = snapshot.sources.filter(source => original.includes(source.url));
  let historyError = false;
  try {
    await DraftStorage.record(info, memo, sources);
  } catch (_) {
    historyError = true;
  }
  if ($('#content').val() !== original) await DraftEditor.flush();
  AIReview.onMemoSaved(original);
  await DraftStorage.finish(snapshot);
  await DraftEditor.reload();
  await DraftStorage.put('local', { [key]: null });
  $('#lastMemoLink').attr('href', MemosAPI.buildMemoUrl(info.apiUrl, memo));
  $('#saveStatus').prop('hidden', false);
  checkSavedVisibility(info, memo);
  $.message({ message: uiMessage(historyError ? 'historyWriteFailed' : 'memoSuccess') });
  Workspace.refreshHistory();
  MemoIndex.saved(info, memo).then(() => refreshTagList(info));
}

function refreshSaveButton() {
  $('#content_submit_text').prop('disabled', memoSaveInProgress || !Workspace.isVisibilityReady());
}

async function sendText() {
  if (memoSaveInProgress || !Workspace.isVisibilityReady()) return;
  const requested = $('#content').val();
  if (!requested.trim()) {
    $.message({ message: uiMessage('placeContent') });
    return;
  }
  if (AIReview.isBusy() || pendingUploads) {
    $.message({ message: uiMessage(pendingUploads ? 'picUploading' : 'aiOptimizing') });
    return;
  }
  memoSaveInProgress = true;
  $('#content').prop('readOnly', true);
  refreshSaveButton();
  try {
    const selection = Workspace.captureDestination(requested);
    if (!(await DraftEditor.flush())) return;
    const snapshot = DraftEditor.snapshot();
    if (snapshot.open_content !== requested) throw new Error('draftChanged');
    const info = await new Promise(resolve => get_info(resolve));
    if (!info.status) {
      $.message({ message: uiMessage('connectMemos') });
      return;
    }
    $.message({ message: uiMessage('memoUploading') });
    await DraftStorage.locked('memos-submit', () => submitMemo(info, snapshot, selection));
  } catch (error) {
    if (
      ['draftChanged', 'destinationChanged', 'spaceUnavailable', 'stagedFileMissing', 'unconfirmedSave'].includes(
        error.message
      )
    )
      $.message({ message: uiMessage(error.message) });
    else showApiError('Save memo', error, uiMessage('memoFailed'));
    // The server took less than the remembered limit allows.
    if (error && error.status === 413) get_info(info => info.status && StagedFiles.refreshLimit(info, true));
  } finally {
    memoSaveInProgress = false;
    $('#content').prop('readOnly', false);
    refreshSaveButton();
  }
}
