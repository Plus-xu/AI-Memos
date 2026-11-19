/** Serialize local keystrokes and reconcile changes from other extension surfaces. */
var DraftEditor = (function () {
  let base, editor, pending, saving, conflict = false;
  const sources = new Map();
  let requested = false, conflictKey;
  function storeConflict() {
    const value = conflict ? { text: editor.value, sources: Array.from(sources.values()) } : null;
    return DraftStorage.put('local', { [conflictKey]: value });
  }

  function showConflict(value) {
    conflict = value;
    $('#draftConflict').prop('hidden', !value);
  }

  function apply(draft) {
    const before = editor.value;
    if (before !== draft.open_content) {
      const start = editor.selectionStart, end = editor.selectionEnd;
      editor.value = draft.open_content;
      editor.setSelectionRange(Math.min(start, editor.value.length), Math.min(end, editor.value.length));
    }
    base = draft;
    if (typeof AIReview !== 'undefined') AIReview.refresh();
    if (typeof Workspace !== 'undefined') Workspace.refreshVisibility();
  }

  async function init(element, draft) {
    editor = element;
    conflictKey = 'memosDraftConflict:' + (document.documentElement?.dataset?.view === 'panel' ? 'panel' : 'popup');
    apply(draft);
    chrome.storage.onChanged?.addListener((changes, area) => {
      const next = changes.memosDraft && changes.memosDraft.newValue;
      if (area === 'local' && next && next.revision > base.revision && !saving && !conflict && editor.value === base.open_content) apply(next);
    });
    $('#draftUseLatest').click(async () => {
      sources.clear(); showConflict(false); apply(await DraftStorage.current()); await storeConflict();
    });
    $('#draftKeepBoth').click(async () => {
      const draft = await DraftStorage.append(editor.value, null, Array.from(sources.values()));
      sources.clear(); showConflict(false); apply(draft); await storeConflict();
    });
    const backup = (await DraftStorage.get('local', { [conflictKey]: null }))[conflictKey];
    if (backup && typeof backup.text === 'string' && backup.text !== base.open_content) {
      editor.value = backup.text;
      for (const source of backup.sources || []) note(source);
      showConflict(true);
      if (typeof AIReview !== 'undefined') AIReview.refresh();
      if (typeof Workspace !== 'undefined') Workspace.refreshVisibility();
    }
    element.readOnly = false;
  }

  function note(source) { if (source) sources.set(source.url, source); }

  function flush() {
    if (!base) return Promise.resolve(false);
    if (conflict) return storeConflict().then(() => false).catch(() => {
      $.message({ message: getLLMMessage('draftSaveFailed') }); return false;
    });
    requested = true;
    if (pending) return pending;
    saving = true;
    pending = (async () => {
      while (requested) {
        requested = false;
        const old = base, text = editor.value, additions = Array.from(sources.values());
        try {
          const draft = await DraftStorage.commit(old, text, additions);
          additions.forEach(source => sources.delete(source.url));
          if (editor.value === text) apply(draft);
          else {
            const combined = DraftStorage.merge(text, editor.value, draft.open_content);
            if (combined === null) { base = draft; showConflict(true); await storeConflict(); return false; }
            editor.value = combined; base = draft; requested = true;
          }
        } catch (error) {
          if (error.latest) { base = error.latest; showConflict(true); await storeConflict(); }
          else $.message({ message: getLLMMessage('draftSaveFailed') });
          return false;
        }
      }
      return true;
    })().finally(() => { saving = false; pending = null; });
    return pending;
  }

  async function reload() {
    const draft = await DraftStorage.current();
    if (!saving && !conflict && (!base || editor.value === base.open_content)) apply(draft);
    return draft;
  }

  return { init, note, flush, reload, snapshot: () => base };
})();
