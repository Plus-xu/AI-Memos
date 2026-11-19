dayjs.extend(window.dayjs_plugin_relativeTime)
dayjs.locale('zh-cn')

var memoSaveInProgress = false;
var pendingUploads = 0;
var previewGeneration = 0;
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
      userName: '', memosVersion: ''
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
        userName: items.userName, memosVersion: items.memosVersion
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

  var errorMsg = fallbackMessage || uiMessage("apiFailed") || 'API call failed';
  if (xhr && xhr.code === 'invalid_url') {
    errorMsg = uiMessage("invalidUrl");
  } else if (xhr && xhr.status === 401) {
    errorMsg = uiMessage("invalidToken");
  } else if (xhr && xhr.status === 403) {
    errorMsg = uiMessage("permissionDenied");
  } else if (xhr && (xhr.status === 404 || xhr.status === 410)) {
    errorMsg = uiMessage("apiNotFound");
  } else if (xhr && xhr.status === 413) {
    errorMsg = uiMessage("uploadTooLarge");
  } else if (xhr && xhr.status === 429) {
    var details = xhr.responseJSON && xhr.responseJSON.details;
    if (!Array.isArray(details)) details = [];
    var quota = details.some(function (detail) { return detail.reason === 'QUOTA_EXCEEDED'; });
    errorMsg = uiMessage(quota ? "quotaExceeded" : "requestLimited");
  } else if (xhr && (xhr.statusText === 'timeout' || xhr.name === 'TimeoutError')) {
    errorMsg = uiMessage("apiTimeout");
  } else if (xhr && xhr.responseJSON && typeof xhr.responseJSON.message === 'string') {
    errorMsg += ': ' + xhr.responseJSON.message.slice(0, 240);
  }

  $.message({ message: errorMsg });
}

function resolveVisibility(info) {
  var hideTag = info.hidetag;
  var showTag = info.showtag;
  var nowTag = $("textarea[name=text]").val().match(/(#[^\s#]+)/);
  var sendvisi = info.memo_lock || 'PRIVATE';

  if (nowTag) {
    if (nowTag[1] === showTag) {
      sendvisi = 'PUBLIC';
    } else if (nowTag[1] === hideTag) {
      sendvisi = 'PRIVATE';
    }
  }

  return sendvisi;
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

function previewLink(info, value, label) {
  var url = previewUrl(info, value);
  if (!url) return escapeHtml(label || '');
  var file = MemosAPI.managedFile(info.apiUrl, url);
  var attributes = file ? ' class="memos-file-link" data-url="' + escapeHtml(url) + '"' : '';
  return '<a href="' + escapeHtml(url) + '"' + attributes + ' target="_blank" rel="noreferrer noopener">' + escapeHtml(label) + '</a>';
}

function renderMarkdownPreview(content, info) {
  var html = '';
  var last = 0;
  String(content).replace(/(!?)\[((?:\\.|[^\]\\\n])*)\]\(([^\s)]+)\)/g, function (match, image, label, url, offset) {
    html += escapeHtml(content.slice(last, offset));
    label = label.replace(/\\([\\\[\]])/g, '$1');
    html += image ? previewImage(info, url, label) : previewLink(info, url, label);
    last = offset + match.length;
    return match;
  });
  return html + escapeHtml(content.slice(last));
}

function releaseMemoPreviews() {
  previewGeneration++;
  if (previewController) previewController.abort();
  previewController = null;
  previewObjectUrls.forEach(function (url) { URL.revokeObjectURL(url); });
  previewObjectUrls.clear();
}

function clearMemoList() {
  releaseMemoPreviews();
  $("#randomlist").html('').hide();
}

function hydrateMemoImages(info) {
  var generation = previewGeneration;
  previewController = new AbortController();
  var signal = previewController.signal;
  var files = new Map();
  document.querySelectorAll('#randomlist img[data-memos-file]').forEach(function (element) {
    var url = element.getAttribute('data-memos-file');
    if (!files.has(url)) {
      files.set(url, MemosAPI.fetchAttachmentBlob(info, url, signal).then(function (blob) {
        if (generation !== previewGeneration) return '';
        if (!blob.type.startsWith('image/')) throw new Error('invalid_image_response');
        var objectUrl = URL.createObjectURL(blob);
        previewObjectUrls.add(objectUrl);
        return objectUrl;
      }));
    }
    files.get(url).then(function (objectUrl) {
      if (!objectUrl || generation !== previewGeneration) return;
      element.src = objectUrl;
      element.removeAttribute('no-view');
    }).catch(function (error) {
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
      html += previewLink(info, fileUrl, filename);
    }
  }

  return html;
}

function buildMemoHtml(info, memo) {
  var memoId = MemosAPI.getMemoId(memo);
  var memoUrl = MemosAPI.buildMemoUrl(info.apiUrl, memo);
  var createTime = memo.createTime || memo.createdTs || '';
  var timeText = createTime ? dayjs(createTime).fromNow() : '';

  var itemHtml = '<article class="random-item"><div class="random-time">' + escapeHtml(timeText);
  itemHtml += '<button type="button" class="random-link" data-uid="' + escapeHtml(memoId) + '" data-url="' + escapeHtml(memoUrl) + '">' + escapeHtml(uiMessage('openSaved')) + '</button>';
  if (memo.creator === info.userName || !memo.creator)
    itemHtml += '<button type="button" class="random-delete" data-name="' + escapeHtml(memo.name) + '">' + escapeHtml(uiMessage('archiveAction')) + '</button>';
  itemHtml += '</div><div class="random-content">' + renderMarkdownPreview(memo.content || '', info) + '</div>';
  itemHtml += buildMemoAttachmentHtml(info, memo);
  itemHtml += '</article>';

  return itemHtml;
}

function renderMemoList(info, memos) {
  releaseMemoPreviews();
  var memoHtml = '';
  for (var i = 0; i < memos.length; i++) {
    memoHtml += buildMemoHtml(info, memos[i]);
  }

  $("#randomlist").html(memoHtml).show();
  hydrateMemoImages(info);
  window.ViewImage && ViewImage.init('.random-image');
}

get_info(function (info) {
  Workspace.configure(info);
  const editor = document.getElementById('content');
  DraftStorage.load(function (draft) {
    return DraftEditor.init(editor, draft).then(() => editor.focus());
  }).catch(() => $.message({ message: uiMessage('draftSaveFailed') }));
});

function saveCurrentDraft() {
  Workspace.refreshVisibility();
  $('#saveStatus').prop('hidden', true);
  return DraftEditor.flush();
}

$("textarea[name=text]").on('input', saveCurrentDraft);
$("textarea[name=text]").on('keydown', function (event) {
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
  editor.focus(); editor.setSelectionRange(start + text.length, start + text.length);
  $('#content').trigger('input');
}

async function addFiles(files) {
  if (!files.length || memoSaveInProgress) return;
  pendingUploads++;
  try {
    const references = [];
    for (const file of files) references.push(await StagedFiles.stage(file, file.name));
    add(references.join('\n'));
    await DraftEditor.flush();
    $.message({ message: uiMessage('fileStaged') });
  } catch (_) { $.message({ message: uiMessage('picFailed') }); }
  finally { pendingUploads--; }
}

document.addEventListener('paste', event => {
  if (event.target.id !== 'content' || !event.clipboardData?.files.length) return;
  event.preventDefault(); addFiles(Array.from(event.clipboardData.files));
});
const memoEditor = document.getElementById('content');
memoEditor.ondragover = event => event.preventDefault();
memoEditor.ondrop = event => {
  if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }
};
$('#newtodo').click(() => add('\n- [ ] '));
$('#upres').click(() => $('#inFile').click());
$('#inFile').on('change', function () { addFiles(Array.from(this.files)); this.value = ''; });

$('#opensite').click(() => get_info(info => {
  if (info.status) chrome.tabs.create({ url: info.apiUrl });
  else chrome.runtime.openOptionsPage();
}));
$('#tags').click(() => get_info(async info => {
  if (!info.status) { $.message({ message: uiMessage('connectMemos') }); return; }
  try {
    const memos = await MemosAPI.listMemos(info);
    const tags = Array.from(new Set(memos.flatMap(m => m.tags || []))).sort();
    if (!tags.length) { $.message({ message: uiMessage('noTagsFound') }); return; }
    const list = $('#taglist').empty();
    for (const tag of tags) list.append($('<button type="button" class="item-container"></button>').text('#' + tag));
    list.toggle();
  } catch (error) { showApiError('Tags', error, uiMessage('getTabFailed')); }
}));
$(document).on('click', '.item-container', function () { add($(this).text() + ' '); });
$('#random').click(() => get_info(async info => {
  if (!info.status) { $.message({ message: uiMessage('connectMemos') }); return; }
  Workspace.resetSearch();
  try {
    const memos = await MemosAPI.listMemos(info);
    if (memos.length) renderMemoList(info, [memos[Math.floor(Math.random() * memos.length)]]);
    else $('#searchStatus').text(uiMessage('noMemosFound'));
  } catch (error) { showApiError('Random memo', error, uiMessage('apiFailed')); }
}));

$(document).on("click", ".random-link", function () {
  var memoUrl = $(this).attr('data-url');
  var memoUid = $(this).attr('data-uid');
  get_info(function (info) {
    chrome.tabs.create({ url: memoUrl || (info.apiUrl + "memos/" + encodeURIComponent(memoUid)) });
  });
});

$(document).on("click", ".random-delete", function () {
  var memosName = $(this).data('name');
  get_info(function (info) {
    MemosAPI.archiveMemo(info, memosName).then(function () {
      clearMemoList();
      $.message({ message: uiMessage("archiveSuccess") });
    }).catch(function (xhr) {
      showApiError('Archive API failed', xhr, uiMessage("archiveFailed"));
    });
  });
});

$(document).on("click", ".memos-file-link", function (event) {
  event.preventDefault();
  var url = $(this).attr('data-url');
  get_info(function (info) {
    MemosAPI.fetchAttachmentBlob(info, url).then(function (blob) {
      var objectUrl = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = objectUrl;
      link.download = MemosAPI.managedFile(info.apiUrl, url).filename;
      link.click();
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 10000);
    }).catch(function (xhr) {
      showApiError('Attachment download failed', xhr, uiMessage("apiFailed"));
    });
  });
});

$('#content_submit_text').click(sendText);

async function submitMemo(info, snapshot, destination) {
  const scope = DraftStorage.scope(info);
  const current = await DraftStorage.current();
  if (snapshot.open_content !== current.open_content || snapshot.revision !== current.revision) throw new Error('draftChanged');
  const original = snapshot.open_content;
  if (!info.memosVersion) {
    try { info.memosVersion = (await MemosAPI.getInstanceProfile(info)).version; }
    catch (_) { /* Version discovery is optional on legacy instances. */ }
  }
  const modern = /^(\d+)\.(\d+)/.exec(info.memosVersion || '');
  const acceptsId = modern && (+modern[1] > 26 || (+modern[1] === 26 && +modern[2] >= 10));
  const input = new TextEncoder().encode(JSON.stringify([scope, original, destination]));
  const signature = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input)), b => b.toString(16).padStart(2, '0')).join('');
  const key = 'memosSaveAttempt:' + scope;
  const prior = (await DraftStorage.get('local', { [key]: null }))[key];
  const retry = prior?.signature === signature;
  const attemptId = retry ? prior.id : crypto.randomUUID();
  if (!retry) await DraftStorage.put('local', { [key]: { signature, id: attemptId } });
  const memoId = acceptsId ? attemptId : undefined;
  const content = await StagedFiles.resolve(info, original, attemptId);
  const body = await MemosAPI.prepareMemo(info, { content, ...destination });
  let memo;
  if (memoId && retry) {
    try { memo = await MemosAPI.getMemo(info, 'memos/' + memoId); }
    catch (error) { if (!MemosAPI.isMissingRoute(error)) throw error; }
    if (memo && (memo.name !== 'memos/' + memoId || memo.content !== body.content)) throw new Error('unconfirmedSave');
  }
  if (!memo) memo = await MemosAPI.createMemo(info, body, memoId);
  if (!memo?.name || !/^memos\/[^/]+$/.test(memo.name)) throw new Error('unconfirmedSave');
  if (memoId && memo.name !== 'memos/' + memoId) throw new Error('unconfirmedSave');
  const sources = snapshot.sources.filter(source => original.includes(source.url));
  let historyError = false;
  try { await DraftStorage.record(info, memo, sources); } catch (_) { historyError = true; }
  if ($('#content').val() !== original) await DraftEditor.flush();
  AIReview.onMemoSaved(original);
  await DraftStorage.finish(snapshot);
  await DraftEditor.reload();
  await DraftStorage.put('local', { [key]: null });
  $('#lastMemoLink').attr('href', MemosAPI.buildMemoUrl(info.apiUrl, memo));
  $('#saveStatus').prop('hidden', false);
  $.message({ message: uiMessage(historyError ? 'historyWriteFailed' : 'memoSuccess') });
  Workspace.refreshHistory();
}

async function sendText() {
  if (memoSaveInProgress) return;
  const requested = $('#content').val();
  if (!requested.trim()) { $.message({ message: uiMessage('placeContent') }); return; }
  if (AIReview.isBusy() || pendingUploads) {
    $.message({ message: uiMessage(pendingUploads ? 'picUploading' : 'aiOptimizing') }); return;
  }
  memoSaveInProgress = true;
  $('#content').prop('readOnly', true);
  $('#content_submit_text').prop('disabled', true);
  try {
    if (!await DraftEditor.flush()) return;
    const snapshot = DraftEditor.snapshot();
    if (snapshot.open_content !== requested) throw new Error('draftChanged');
    const info = await new Promise(resolve => get_info(resolve));
    if (!info.status) { $.message({ message: uiMessage('connectMemos') }); return; }
    $.message({ message: uiMessage('memoUploading') });
    const target = await Workspace.destination(info);
    await DraftStorage.locked('memos-submit', () => submitMemo(info, snapshot, target));
  } catch (error) {
    if (['draftChanged','spaceUnavailable','stagedFileMissing','unconfirmedSave'].includes(error.message)) $.message({ message: uiMessage(error.message) });
    else showApiError('Save memo', error, uiMessage('memoFailed'));
  } finally {
    memoSaveInProgress = false;
    $('#content').prop('readOnly', false);
    $('#content_submit_text').prop('disabled', false);
  }
}
