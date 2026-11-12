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
      userName: ''
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
        userName: items.userName
      };

      DraftStorage.load(function (draft) {
        returnObject.open_content = draft.open_content;
        returnObject.open_action = draft.open_action;
        if (callback) callback(returnObject);
      });
    }
  );
}

function showApiError(prefix, xhr, fallbackMessage) {
  console.error(prefix, {
    status: xhr && xhr.status,
    statusText: xhr && xhr.statusText,
    code: xhr && xhr.code
  });

  var errorMsg = fallbackMessage || chrome.i18n.getMessage("apiFailed") || 'API call failed';
  if (xhr && xhr.code === 'invalid_url') {
    errorMsg = chrome.i18n.getMessage("invalidUrl");
  } else if (xhr && xhr.status === 401) {
    errorMsg = chrome.i18n.getMessage("invalidToken");
  } else if (xhr && xhr.status === 403) {
    errorMsg = chrome.i18n.getMessage("permissionDenied");
  } else if (xhr && (xhr.status === 404 || xhr.status === 410)) {
    errorMsg = chrome.i18n.getMessage("apiNotFound");
  } else if (xhr && xhr.status === 413) {
    errorMsg = chrome.i18n.getMessage("uploadTooLarge");
  } else if (xhr && xhr.status === 429) {
    var details = xhr.responseJSON && xhr.responseJSON.details;
    if (!Array.isArray(details)) details = [];
    var quota = details.some(function (detail) { return detail.reason === 'QUOTA_EXCEEDED'; });
    errorMsg = chrome.i18n.getMessage(quota ? "quotaExceeded" : "requestLimited");
  } else if (xhr && (xhr.statusText === 'timeout' || xhr.name === 'TimeoutError')) {
    errorMsg = chrome.i18n.getMessage("apiTimeout");
  } else if (xhr && xhr.responseJSON && typeof xhr.responseJSON.message === 'string') {
    errorMsg += ': ' + xhr.responseJSON.message.slice(0, 240);
  }

  $.message({ message: escapeHtml(errorMsg) });
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
      element.alt = chrome.i18n.getMessage('attachmentPreviewFailed');
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

  var itemHtml = '<div class="random-item"><div class="random-time">';
  itemHtml += '<span class="random-link" data-uid="' + escapeHtml(memoId) + '" data-url="' + escapeHtml(memoUrl) + '"><svg class="icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M864 640a32 32 0 0 1 64 0v224.096A63.936 63.936 0 0 1 864.096 928H159.904A63.936 63.936 0 0 1 96 864.096V159.904C96 124.608 124.64 96 159.904 96H384a32 32 0 0 1 0 64H192.064A31.904 31.904 0 0 0 160 192.064v639.872A31.904 31.904 0 0 0 192.064 864h639.872A31.904 31.904 0 0 0 864 831.936V640zm-485.184 52.48a31.84 31.84 0 0 1-45.12-.128 31.808 31.808 0 0 1-.128-45.12L815.04 166.048l-176.128.736a31.392 31.392 0 0 1-31.584-31.744 32.32 32.32 0 0 1 31.84-32l255.232-1.056a31.36 31.36 0 0 1 31.584 31.584L924.928 388.8a32.32 32.32 0 0 1-32 31.84 31.392 31.392 0 0 1-31.712-31.584l.736-179.392L378.816 692.48z" fill="#666" class="selected"/></svg></span>';
  itemHtml += '<span class="random-delete" data-name="' + escapeHtml(memo.name) + '" data-uid="' + escapeHtml(memoId) + '"><svg class="icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M224 322.6h576c16.6 0 30-13.4 30-30s-13.4-30-30-30H224c-16.6 0-30 13.4-30 30 0 16.5 13.5 30 30 30zm66.1-144.2h443.8c16.6 0 30-13.4 30-30s-13.4-30-30-30H290.1c-16.6 0-30 13.4-30 30s13.4 30 30 30zm339.5 435.5H394.4c-16.6 0-30 13.4-30 30s13.4 30 30 30h235.2c16.6 0 30-13.4 30-30s-13.4-30-30-30z" fill="#666"/><path d="M850.3 403.9H173.7c-33 0-60 27-60 60v360c0 33 27 60 60 60h676.6c33 0 60-27 60-60v-360c0-33-27-60-60-60zm-.1 419.8l-.1.1H173.9l-.1-.1V464l.1-.1h676.2l.1.1v359.7z" fill="#666"/></svg></span>';
  itemHtml += escapeHtml(timeText) + '</div>';
  itemHtml += '<div class="random-content">' + renderMarkdownPreview(memo.content || '', info) + '</div>';
  itemHtml += buildMemoAttachmentHtml(info, memo);
  itemHtml += '</div>';

  return itemHtml;
}

function renderMemoList(info, memos) {
  releaseMemoPreviews();
  var memoHtml = '';
  for (var i = 0; i < memos.length; i++) {
    memoHtml += buildMemoHtml(info, memos[i]);
  }

  $("#randomlist").html(memoHtml).slideDown(500);
  hydrateMemoImages(info);
  window.ViewImage && ViewImage.init('.random-image');
}

get_info(function (info) {
  if (info.status) {
    $('#blog_info').hide();
  }

  var memoNow = info.memo_lock;
  if (memoNow === '') {
    chrome.storage.sync.set({ memo_lock: 'PRIVATE' });
    $("#lock-now").text(chrome.i18n.getMessage("lockPrivate"));
  }
  if (memoNow === "PUBLIC") {
    $("#lock-now").text(chrome.i18n.getMessage("lockPublic"));
  } else if (memoNow === "PRIVATE") {
    $("#lock-now").text(chrome.i18n.getMessage("lockPrivate"));
  } else if (memoNow === "PROTECTED") {
    $("#lock-now").text(chrome.i18n.getMessage("lockProtected"));
  }

  $('#apiUrl').val(info.apiUrl);
  $('#apiTokens').val(info.apiTokens);
  $('#hideInput').val(info.hidetag);
  $('#showInput').val(info.showtag);
  if (info.open_action === 'upload_image') {
    uploadImage(info.open_content);
  } else {
    $("textarea[name=text]").val(info.open_content);
  }
  setTimeout(get_info, 1);
});

$("textarea[name=text]").focus();

function saveCurrentDraft() {
  DraftStorage.save(
    { open_action: 'save_text', open_content: $("textarea[name=text]").val() },
    function (error) {
      if (error) $.message({ message: chrome.i18n.getMessage("draftSaveFailed") });
    }
  );
}

$("textarea[name=text]").blur(saveCurrentDraft).on('input', saveCurrentDraft);

$("textarea[name=text]").on('keydown', function (ev) {
  if (ev.code === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    $('#content_submit_text').click();
  }
});

initDrag();

document.addEventListener('paste', function (e) {
  var photo = null;
  if (e.clipboardData.files[0]) {
    photo = e.clipboardData.files[0];
  } else if (e.clipboardData.items[0] && e.clipboardData.items[0].getAsFile()) {
    photo = e.clipboardData.items[0].getAsFile();
  }

  if (photo != null) {
    uploadImage(photo);
  }
});

function initDrag() {
  var file = null;
  var obj = $("textarea[name=text]")[0];
  obj.ondragenter = function (ev) {
    if (ev.target.className === 'common-editor-inputer') {
      $.message({
        message: chrome.i18n.getMessage("picDrag"),
        autoClose: false
      });
      $('body').css('opacity', 0.3);
    }
    ev.dataTransfer.dropEffect = 'copy';
  };
  obj.ondragover = function (ev) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  };
  obj.ondrop = function (ev) {
    $('body').css('opacity', 1);
    ev.preventDefault();
    var files = ev.dataTransfer.files || ev.target.files;
    for (var i = 0; i < files.length; i++) {
      file = files[i];
    }
    uploadImage(file);
  };
  obj.ondragleave = function (ev) {
    ev.preventDefault();
    if (ev.target.className === 'common-editor-inputer') {
      $.message({
        message: chrome.i18n.getMessage("picCancelDrag")
      });
      $('body').css('opacity', 1);
    }
  };
}

function uploadImage(file) {
  if (!file) return;
  if (memoSaveInProgress) {
    $.message({ message: chrome.i18n.getMessage("memoUploading") });
    return;
  }
  pendingUploads++;

  $.message({
    message: chrome.i18n.getMessage("picUploading"),
    autoClose: false
  });

  new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function (e) { resolve(e.target.result.split(',')[1]); };
    reader.onerror = function () { reject(reader.error || new Error('file_read_failed')); };
    reader.readAsDataURL(file);
  }).then(function (base64String) {
    return uploadImageNow(base64String, file);
  }).catch(function (xhr) {
    showApiError('Attachment upload failed', xhr, chrome.i18n.getMessage("picFailed"));
  }).finally(function () {
    pendingUploads--;
  });
}

function uploadImageNow(base64String, file) {
  return new Promise(function (resolve) { get_info(resolve); }).then(function (info) {
    if (!info.status) {
      throw new Error('missing_connection');
    }

    var originalName = file.name || 'attachment';
    var dot = originalName.lastIndexOf('.');
    var suffix = '_' + Date.now();
    var newName = dot > 0 ? originalName.slice(0, dot) + suffix + originalName.slice(dot) : originalName + suffix;
    var data = {
      content: base64String,
      filename: newName,
      type: file.type
    };

    return MemosAPI.uploadAttachment(info, data).then(function (attachment) {
      if (!attachment.name) {
        throw new Error('missing_attachment_name');
      }

      var fileUrl = MemosAPI.buildFileUrl(info.apiUrl, attachment);
      var label = newName.replace(/[\\\[\]]/g, '\\$&');
      var insertText = (attachment.type || file.type || '').startsWith('image/')
        ? '![' + label + '](' + fileUrl + ')'
        : '[' + label + '](' + fileUrl + ')';

      var textarea = $("textarea[name=text]")[0];
      var startPos = textarea.selectionStart;
      var endPos = textarea.selectionEnd;
      var currentValue = textarea.value;
      var newValue = currentValue.substring(0, startPos) + insertText + currentValue.substring(endPos);

      textarea.value = newValue;
      textarea.setSelectionRange(startPos + insertText.length, startPos + insertText.length);
      textarea.focus();

      DraftStorage.save(
        {
          open_action: '',
          open_content: newValue
        },
        function (error) {
          $.message({ message: chrome.i18n.getMessage(error ? "draftSaveFailed" : "picSuccess") });
        }
      );
    });
  });
}

$('#saveKey').click(function () {
  var apiUrl = MemosAPI.normalizeBaseUrl($('#apiUrl').val());
  var apiTokens = $('#apiTokens').val().trim();

  MemosAPI.currentUser(apiUrl, apiTokens).then(function (userInfo) {
    // Version discovery is informational; an older profile endpoint must not
    // prevent an otherwise valid PAT from being saved.
    return MemosAPI.getInstanceProfile({ apiUrl: apiUrl, apiTokens: apiTokens })
      .catch(function () { return { version: '' }; })
      .then(function (profile) { return { user: userInfo, version: profile.version }; });
  }).then(function (connection) {
    var userInfo = connection.user;
    if (typeof saveLLMConfig === 'function') {
      saveLLMConfig();
    }

    chrome.storage.sync.set(
      {
        apiUrl: apiUrl,
        apiTokens: apiTokens,
        userid: userInfo.userId,
        userName: userInfo.userName,
        memosVersion: connection.version
      },
      function () {
        var versionText = connection.version ? ' · Memos ' + connection.version : '';
        $.message({ message: escapeHtml(chrome.i18n.getMessage("saveSuccess") + versionText) });
        $('#blog_info').hide();
      }
    );
  }).catch(function (xhr) {
    showApiError('Connection check failed', xhr, chrome.i18n.getMessage("apiFailed"));
  });
});

$('#opensite').click(function () {
  get_info(function (info) {
    chrome.tabs.create({ url: info.apiUrl });
  });
});

$('#tags').click(function () {
  get_info(function (info) {
    if (!info.status) {
      $.message({ message: chrome.i18n.getMessage("placeApiUrl") });
      return;
    }

    var tagDom = "";
    MemosAPI.listMemos(info, '?pageSize=1000').then(function (memos) {
      if (!memos.length) {
        $.message({ message: chrome.i18n.getMessage("noMemosFound") });
        return;
      }

      var allTags = memos.flatMap(function (memo) {
        return memo.tags || [];
      });
      var uniTags = Array.from(new Set(allTags));

      if (uniTags.length === 0) {
        $.message({ message: chrome.i18n.getMessage("noTagsFound") });
        return;
      }

      $.each(uniTags, function (_, tag) {
        tagDom += '<span class="item-container">#' + escapeHtml(tag) + '</span>';
      });
      tagDom += '<svg id="hideTag" class="hidetag" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M78.807 362.435c201.539 314.275 666.962 314.188 868.398-.241 16.056-24.99 13.143-54.241-4.04-62.54-17.244-8.377-40.504 3.854-54.077 24.887-174.484 272.338-577.633 272.41-752.19.195-13.573-21.043-36.874-33.213-54.113-24.837-17.177 8.294-20.06 37.545-3.978 62.536z" fill="#fff"/><path d="M894.72 612.67L787.978 494.386l38.554-34.785 106.742 118.251-38.554 34.816zM635.505 727.51l-49.04-147.123 49.255-16.41 49.054 147.098-49.27 16.435zm-236.18-12.001l-49.568-15.488 43.29-138.48 49.557 15.513-43.28 138.455zM154.49 601.006l-38.743-34.565 95.186-106.732 38.763 34.566-95.206 106.731z" fill="#fff"/></svg>';
      $("#taglist").html(tagDom).slideToggle(500);
    }).catch(function (xhr) {
      showApiError('Tags API failed', xhr, chrome.i18n.getMessage("apiFailed"));
    });
  });
});

$(document).on("click", "#hideTag", function () {
  $('#taghide').slideToggle(500);
});

$('#saveTag').click(function () {
  chrome.storage.sync.set(
    {
      hidetag: $('#hideInput').val(),
      showtag: $('#showInput').val()
    },
    function () {
      $.message({ message: chrome.i18n.getMessage("saveSuccess") });
      $('#taghide').hide();
    }
  );
});

$('#lock').click(function () {
  $("#lock-wrapper").toggleClass("!hidden", 1000);
});

$(document).on("click", ".item-lock", function () {
  $("#lock-wrapper").toggleClass("!hidden", 1000);
  $("#lock-now").text($(this).text());
  var selectedVisibility = $(this)[0].dataset.type;
  chrome.storage.sync.set({ memo_lock: selectedVisibility });
});

$('#search').click(function () {
  get_info(function (info) {
    var pattern = $("textarea[name=text]").val();
    if (!info.status) {
      $.message({ message: chrome.i18n.getMessage("placeApiUrl") });
      return;
    }
    if (!pattern) {
      $.message({ message: chrome.i18n.getMessage("searchNow") });
      return;
    }

    var filterExpr = MemosAPI.buildContentFilter(pattern);
    var filter = "?filter=" + encodeURIComponent(filterExpr);

    clearMemoList();
    MemosAPI.listMemos(info, filter).then(function (memos) {
      if (!memos.length) {
        $.message({ message: chrome.i18n.getMessage("noSearchResults") });
        return;
      }
      renderMemoList(info, memos);
    }).catch(function (xhr) {
      showApiError('Search API failed', xhr, chrome.i18n.getMessage("apiFailed"));
    });
  });
});

$('#random').click(function () {
  get_info(function (info) {
    if (!info.status) {
      $.message({ message: chrome.i18n.getMessage("placeApiUrl") });
      return;
    }

    clearMemoList();
    MemosAPI.listMemos(info).then(function (memos) {
      if (!memos.length) {
        $.message({ message: chrome.i18n.getMessage("noMemosFound") });
        return;
      }

      var randomNum = Math.floor(Math.random() * memos.length);
      randDom(memos[randomNum]);
    }).catch(function (xhr) {
      showApiError('Random API failed', xhr, chrome.i18n.getMessage("apiFailed"));
    });
  });
});

function randDom(randomData) {
  get_info(function (info) {
    renderMemoList(info, [randomData]);
  });
}

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
      $.message({ message: chrome.i18n.getMessage("archiveSuccess") });
    }).catch(function (xhr) {
      showApiError('Archive API failed', xhr, chrome.i18n.getMessage("archiveFailed"));
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
      showApiError('Attachment download failed', xhr, chrome.i18n.getMessage("apiFailed"));
    });
  });
});

$(document).on("click", ".item-container", function () {
  add($(this).text() + " ");
});

$('#newtodo').click(function () {
  add("\n- [ ] ");
});

$('#getlink').click(function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs[0] || {};
    var linkHtml = " [" + tab.title + "](" + tab.url + ") ";
    if (tab.url) {
      add(linkHtml);
    } else {
      $.message({ message: chrome.i18n.getMessage("getTabFailed") });
    }
  });
});

$('#upres').click(function () {
  $('#inFile').click();
});

$('#inFile').on('change', function () {
  var fileVal = $('#inFile').val();
  if (fileVal === '') {
    return;
  }
  uploadImage(this.files[0]);
});

function add(str) {
  var tc = document.getElementById("content");
  var tclen = tc.value.length;
  tc.focus();
  if (typeof document.selection !== "undefined") {
    document.selection.createRange().text = str;
  } else {
    tc.value =
      tc.value.substr(0, tc.selectionStart) +
      str +
      tc.value.substring(tc.selectionStart, tclen);
  }
  saveCurrentDraft();
}

$('#blog_info_edit').click(function () {
  $('#blog_info').slideToggle();
});

$('#content_submit_text').click(function () {
  var contentVal = $("textarea[name=text]").val();
  if (contentVal) {
    sendText();
  } else {
    $.message({ message: chrome.i18n.getMessage("placeContent") });
  }
});

function getOne(memosName) {
  get_info(function (info) {
    if (!info.status) {
      $.message({ message: chrome.i18n.getMessage("placeApiUrl") });
      return;
    }

    clearMemoList();
    MemosAPI.getMemo(info, memosName).then(function (data) {
      randDom(data);
    }).catch(function (xhr) {
      showApiError('Get memo API failed', xhr, chrome.i18n.getMessage("apiFailed"));
    });
  });
}

function sendText() {
  if (memoSaveInProgress) return;
  if (pendingUploads) {
    $.message({ message: chrome.i18n.getMessage("picUploading") });
    return;
  }
  memoSaveInProgress = true;
  $("textarea[name=text]").prop('readOnly', true);
  $('#content_submit_text').attr('aria-disabled', 'true');
  get_info(function (info) {
    if (!info.status) {
      $.message({ message: chrome.i18n.getMessage("placeApiUrl") });
      finishMemoSave();
      return;
    }

    $.message({ message: chrome.i18n.getMessage("memoUploading") });

    var content = $("textarea[name=text]").val();
    var body = {
      content: content,
      visibility: resolveVisibility(info)
    };

    MemosAPI.prepareMemo(info, body).then(function (prepared) {
      return MemosAPI.createMemo(info, prepared);
    }).then(function (data) {
      getOne(data.name);
      var current = $("textarea[name=text]").val();
      var remaining = current === content ? '' : current;
      $("textarea[name=text]").val(remaining);
      DraftStorage.save(
        { open_action: remaining ? 'save_text' : '', open_content: remaining },
        function (error) {
          $.message({ message: chrome.i18n.getMessage(error ? "draftSaveFailed" : "memoSuccess") });
        }
      );
    }).catch(function (xhr) {
      DraftStorage.save(
        { open_action: 'save_text', open_content: $("textarea[name=text]").val() },
        function () {
          showApiError('Create memo API failed', xhr, chrome.i18n.getMessage("memoFailed"));
        }
      );
    }).finally(finishMemoSave);
  });
}

function finishMemoSave() {
  memoSaveInProgress = false;
  $("textarea[name=text]").prop('readOnly', false);
  $('#content_submit_text').removeAttr('aria-disabled');
}
