/* global AIReview, DraftEditor, DraftStorage, MemoIndex, MemosAPI, StagedFiles, appendMemoList, clearMemoList, closeTagList, dismissArchiveNotice, get_info, refreshSaveButton, renderMemoList, resolveVisibility, showApiError, uiMessage */
/* exported Workspace */
/** Shared editor navigation, destinations, server search and local clip history. */
var Workspace = (function () {
  const el = id => document.getElementById(id);
  let account,
    space = '',
    visibility = 'PRIVATE',
    spaces = [],
    missing = false,
    visibilityReady = false;
  let configuring = Promise.resolve();
  let destinationGeneration = 0,
    selectionRevision = 0,
    searchGeneration = 0,
    listGeneration = 0,
    nextPage = '',
    query = '',
    results = [],
    seen = new Set();
  let selectedTab = 'write',
    browserWindow,
    historyGeneration = 0;
  const labels = { PRIVATE: 'lockPrivate', PROTECTED: 'lockProtected', PUBLIC: 'lockPublic', SPACE: 'lockSpace' };

  function tab(name) {
    selectedTab = name;
    for (const button of document.querySelectorAll('[data-tab]')) {
      if (button.dataset.tab === name) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
      el(button.dataset.tab + 'View').hidden = button.dataset.tab !== name;
    }
    if (name === 'history') refreshHistory();
    el({ write: 'content', search: 'searchQuery', history: 'historyQuery' }[name]).focus();
  }

  function refreshVisibility() {
    if (!account) return;
    const value = resolveVisibility({ ...account, memo_lock: visibility });
    el('effectiveVisibility').textContent = missing
      ? uiMessage('spaceUnavailable')
      : value === visibility
        ? ''
        : uiMessage('ruleEffective').replace('{value}', uiMessage(labels[value]));
    el('spaceVisibility').hidden = !space;
    el('spaceVisibility').disabled = !space;
  }

  function widerVisibility(before, after) {
    const rules = { ...account, memo_lock: visibility };
    const from = resolveVisibility(rules, before);
    const to = resolveVisibility(rules, after);
    // A tag rule can only change the selected visibility to PRIVATE or PUBLIC.
    if (from === to || (from !== 'PRIVATE' && to !== 'PUBLIC')) return null;
    return { from: labels[from], to: labels[to], account: DraftStorage.scope(account), space };
  }

  function renderSpaces() {
    const select = el('memoSpace');
    select.replaceChildren(new Option(uiMessage('noSpace'), ''));
    for (const entry of spaces) select.add(new Option(entry.title || entry.name, entry.name));
    missing = !!space && !spaces.some(entry => entry.name === space);
    if (missing) select.add(new Option(space + ' · ' + uiMessage('spaceUnavailable'), space));
    select.value = space;
    el('spaceField').hidden = !spaces.length && !space;
    el('visibility').value = visibility;
    refreshVisibility();
  }

  function setVisibilityReady(ready) {
    visibilityReady = ready;
    refreshSaveButton();
    AIReview.refresh();
  }

  function configure(info, tokenChanged = false) {
    const run = ++destinationGeneration;
    setVisibilityReady(false);
    configuring = loadDestination(info, run, tokenChanged);
    return configuring;
  }

  // The remembered list only draws the popup sooner; destination() still asks the server before a save.
  function spaceList(entries) {
    if (!Array.isArray(entries)) return null;
    return entries
      .filter(entry => entry && /^spaces\/[^/]+$/.test(entry.name))
      .map(entry =>
        typeof entry.title === 'string' ? { name: entry.name, title: entry.title } : { name: entry.name }
      );
  }

  // Draws and remembers a list from the server, if it differs from the one on screen.
  async function showSpaces(info, list) {
    if (JSON.stringify(list) === JSON.stringify(spaces)) return;
    spaces = list;
    renderSpaces();
    try {
      await DraftStorage.put('local', { ['memosSpaces:' + DraftStorage.scope(info)]: { spaces: list } });
    } catch (_) {
      /* Not remembered: the next popup waits for the server instead. */
    }
  }

  async function loadDestination(info, run, tokenChanged) {
    if (!info) info = await new Promise(resolve => get_info(resolve));
    // A token that had expired was shown the public memos only.
    if (tokenChanged && info.status) MemoIndex.clear(info);
    if (run !== destinationGeneration) return;
    account = info;
    spaces = [];
    space = '';
    missing = false;
    visibility = labels[info.memo_lock] && info.memo_lock !== 'SPACE' ? info.memo_lock : 'PRIVATE';
    el('connectNotice').hidden = info.status;
    el('duplicateNotice').hidden = true;
    el('saveStatus').hidden = true;
    renderSpaces();
    if (!info.status) {
      setVisibilityReady(true);
      return;
    }
    // Runs again when the account changes; it never rejects.
    StagedFiles.refreshLimit(info);
    const key = 'memosDestination:' + DraftStorage.scope(info),
      listKey = 'memosSpaces:' + DraftStorage.scope(info);
    const revision = selectionRevision;
    const stored = await DraftStorage.get('local', { [key]: null, [listKey]: null });
    if (run !== destinationGeneration) return;
    const saved = stored[key],
      remembered = spaceList(stored[listKey]?.spaces);
    // The other editor or the destination controls may have supplied a newer selection during the read.
    if (saved && revision === selectionRevision) {
      space = saved.space || '';
      visibility = labels[saved.visibility] ? saved.visibility : 'PRIVATE';
    }
    if (remembered) spaces = remembered;
    renderSpaces();
    setVisibilityReady(true);
    await refreshHistory();
    if (run !== destinationGeneration) return;
    let list = null;
    try {
      list = spaceList(await MemosAPI.listSpaces(info));
    } catch (error) {
      if (run !== destinationGeneration) return;
      if (MemosAPI.isMissingRoute(error)) list = [];
      else $.message({ message: uiMessage('spaceCheckFailed') });
    }
    if (run !== destinationGeneration) return;
    if (list) await showSpaces(info, list);
  }

  function selectDestination(target, selected) {
    // A selection made while loading supersedes the stored value even if it equals the temporary default.
    // Once ready, our own storage notification echoes the selection already made in this editor.
    if (!visibilityReady || target !== space || selected !== visibility) selectionRevision++;
    space = target;
    visibility = selected;
  }

  async function saveDestination() {
    const target = el('memoSpace').value;
    const selected = el('visibility').value;
    selectDestination(target, selected === 'SPACE' && !target ? 'PRIVATE' : selected);
    missing = !!space && !spaces.some(entry => entry.name === space);
    el('visibility').value = visibility;
    refreshVisibility();
    if (account?.status)
      await DraftStorage.put('local', {
        ['memosDestination:' + DraftStorage.scope(account)]: { space, visibility }
      });
  }

  function captureDestination(content) {
    const run = destinationGeneration;
    const revision = selectionRevision;
    const scope = resolveVisibility({ ...account, memo_lock: visibility }, content);
    return {
      body: space ? { visibility: scope, space } : { visibility: scope },
      assertCurrent(info) {
        if (
          !visibilityReady ||
          run !== destinationGeneration ||
          revision !== selectionRevision ||
          DraftStorage.scope(info) !== DraftStorage.scope(account) ||
          ['apiTokens', 'memo_lock', 'hidetag', 'showtag'].some(key => info[key] !== account[key])
        )
          throw new Error('destinationChanged');
      }
    };
  }

  async function destination(info, selection = captureDestination()) {
    await configuring;
    selection.assertCurrent(info);
    const { space: target, visibility: scope } = selection.body;
    if (missing || (scope === 'SPACE' && !target)) throw new Error('spaceUnavailable');
    if (target) {
      const list = spaceList(await MemosAPI.listSpaces(info));
      selection.assertCurrent(info);
      await showSpaces(info, list);
      selection.assertCurrent(info);
      if (!list.some(entry => entry.name === target)) throw new Error('spaceUnavailable');
    }
    return selection.body;
  }

  function resetSearch() {
    searchGeneration++;
    listGeneration++;
    seen = new Set();
    nextPage = '';
    results = [];
    el('searchMore').hidden = true;
    el('searchStatus').textContent = '';
    dismissArchiveNotice();
    clearMemoList();
    return listGeneration;
  }

  function listRun() {
    return listGeneration;
  }

  function renderResults() {
    renderMemoList(account, results);
  }

  function show(memos) {
    results = memos.slice();
    renderResults();
  }

  // Removes one displayed memo and keeps the pagination state.
  function remove(name) {
    const index = results.findIndex(item => item.name === name);
    if (index < 0) return null;
    const memo = results.splice(index, 1)[0];
    renderResults();
    return { memo, index, list: listGeneration };
  }

  function restore(entry) {
    if (!entry || entry.list !== listGeneration || results.some(item => item.name === entry.memo.name)) return;
    results.splice(Math.min(entry.index, results.length), 0, entry.memo);
    renderResults();
  }

  async function search(more = false) {
    if (!account?.status) {
      el('searchStatus').textContent = uiMessage('connectMemos');
      return;
    }
    if (!more) {
      resetSearch();
      const keyword = el('searchQuery').value.trim(),
        tagValue = el('searchTag').value.trim().replace(/^#/, '');
      const terms = [];
      if (keyword) terms.push(MemosAPI.buildContentFilter(keyword));
      if (tagValue) terms.push(JSON.stringify(tagValue) + ' in tags');
      query = terms.join(' && ');
    }
    const run = ++searchGeneration;
    const filter = new URLSearchParams({ pageSize: '25' });
    if (query) filter.set('filter', query);
    if (more && nextPage) filter.set('pageToken', nextPage);
    el('searchMore').disabled = true;
    el('searchStatus').textContent = uiMessage('working');
    try {
      const page = await MemosAPI.listMemoPage(account, filter.toString());
      if (run !== searchGeneration) return;
      if (page.next && seen.has(page.next)) throw new Error('invalid_page_token');
      if (page.next) seen.add(page.next);
      const ids = new Set(results.map(item => item.name));
      const fresh = page.memos.filter(item => !ids.has(item.name) && ids.add(item.name));
      results.push(...fresh);
      nextPage = page.next;
      if (more) appendMemoList(account, fresh);
      else renderResults();
      el('searchStatus').textContent = results.length ? '' : uiMessage('noSearchResults');
      el('searchMore').hidden = !nextPage;
    } catch (error) {
      if (run === searchGeneration) {
        el('searchStatus').textContent = uiMessage('apiFailed');
        showApiError('Search', error, uiMessage('apiFailed'));
      }
    } finally {
      if (run === searchGeneration) el('searchMore').disabled = false;
    }
  }

  function link(title, url) {
    const a = document.createElement('a');
    a.textContent = title;
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  async function refreshHistory(source) {
    const run = ++historyGeneration;
    const list = el('historyList');
    const info = account;
    const rows = info?.status ? await DraftStorage.history(info) : [];
    if (!source) {
      try {
        source = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url;
      } catch (_) {
        /* restricted tab */
      }
    }
    if (run !== historyGeneration) return;
    const duplicate = rows.find(
      item => item.url === source || item.url === String(source).replaceAll('(', '%28').replaceAll(')', '%29')
    );
    el('duplicateNotice').hidden = !duplicate;
    if (duplicate) el('previousMemo').href = MemosAPI.buildMemoUrl(info.apiUrl, { name: duplicate.memo });
    if (selectedTab !== 'history') return;
    list.replaceChildren();
    const term = el('historyQuery').value.trim().toLocaleLowerCase();
    for (const row of rows.filter(item => (item.title + ' ' + item.url).toLocaleLowerCase().includes(term))) {
      const item = document.createElement('article'),
        meta = document.createElement('div');
      item.className = 'history-item';
      meta.className = 'history-meta';
      const date = new Date(row.savedAt);
      meta.append(
        date.toLocaleString(document.documentElement.lang),
        link(uiMessage('openSaved'), MemosAPI.buildMemoUrl(info.apiUrl, { name: row.memo }))
      );
      item.append(link(row.title || row.url, row.url), meta);
      list.append(item);
    }
    if (!list.childElementCount) list.textContent = uiMessage(term ? 'noSearchResults' : 'historyEmpty');
  }

  async function clip(mode) {
    if (!(await DraftEditor.flush())) return;
    el('sourceMenu').open = false;
    el('capturePage').disabled = true;
    try {
      const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!current) throw new Error('clipCaptureFailed');
      const response = await chrome.runtime.sendMessage({ type: 'capture', mode, tabId: current.id, url: current.url });
      if (!response?.result) throw new Error(response?.error || 'clipCaptureFailed');
      await DraftEditor.reload();
      const result = response.result;
      refreshHistory(result.source.url);
      $.message({
        message: uiMessage(
          result.partial
            ? 'imagePartial'
            : { selection: 'addedSelection', article: 'addedArticle', summary: 'addedSummary' }[result.kind]
        )
      });
    } catch (error) {
      $.message({ message: uiMessage(error.message === 'emptySelection' ? 'emptySelection' : 'clipCaptureFailed') });
    } finally {
      el('capturePage').disabled = false;
    }
  }

  function translate() {
    if (account) {
      renderSpaces();
      refreshHistory();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    chrome.windows?.getCurrent().then(win => {
      browserWindow = win.id;
    });
    for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => tab(b.dataset.tab);
    for (const b of document.querySelectorAll('.open-settings')) b.onclick = () => chrome.runtime.openOptionsPage();
    el('openPanel').onclick = async () => {
      try {
        if (browserWindow === undefined) browserWindow = (await chrome.windows.getCurrent()).id;
        await chrome.sidePanel.open({ windowId: browserWindow });
        if ((await DraftEditor.flush()) && location.protocol === 'chrome-extension:') window.close();
      } catch (_) {
        $.message({ message: uiMessage('openPanel') });
      }
    };
    el('capturePage').onclick = () => clip('page');
    el('captureSelection').onclick = () => clip('selection');
    el('memoSpace').onchange = el('visibility').onchange = saveDestination;
    el('searchForm').onsubmit = event => {
      event.preventDefault();
      search();
    };
    el('searchMore').onclick = () => search(true);
    el('historyQuery').oninput = () => refreshHistory();
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        el('sourceMenu').open = false;
        el('ai_quick_menu').classList.add('hidden');
        el('ai_quick_toggle').setAttribute('aria-expanded', 'false');
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.memosClipHistory) refreshHistory();
      if (
        area === 'sync' &&
        ['apiUrl', 'apiTokens', 'userName', 'userid', 'hidetag', 'showtag', 'memo_lock'].some(key => changes[key])
      ) {
        configure(undefined, !!changes.apiTokens);
        resetSearch();
        closeTagList();
      }
      if (area === 'local' && account && changes['memosDestination:' + DraftStorage.scope(account)]) {
        const saved = changes['memosDestination:' + DraftStorage.scope(account)].newValue;
        if (saved) {
          selectDestination(saved.space, saved.visibility);
          renderSpaces();
        } else configure();
      }
    });
    // Listen before starting the first read so a settings change can supersede it even on startup.
    configure();
    chrome.tabs.onActivated?.addListener(() => refreshHistory());
    chrome.tabs.onUpdated?.addListener((id, changes, tabInfo) => {
      if (tabInfo.active && changes.url) refreshHistory();
    });
    DraftStorage.get('local', { memosCaptureError: '' }).then(data => {
      if (data.memosCaptureError) {
        $.message({ message: uiMessage('clipContextFailed') });
        chrome.storage.local.remove('memosCaptureError');
        chrome.action?.setBadgeText({ text: '' });
      }
    });
    StagedFiles.collect().catch(() => {});
  });
  return {
    configure,
    captureDestination,
    destination,
    widerVisibility,
    isVisibilityReady: () => visibilityReady,
    refreshVisibility,
    refreshHistory,
    resetSearch,
    listRun,
    show,
    remove,
    restore,
    translate,
    tab
  };
})();
