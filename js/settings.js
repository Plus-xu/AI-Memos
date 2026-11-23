/* global DraftStorage, MemoTags, MemosAPI, ModelCatalog, cacheCurrentProviderForm, extractLLMErrorMessage, getCurrentFormConfig, persistLLMState, rebuildModelChoices, uiMessage */
document.addEventListener('DOMContentLoaded', () => {
  const el = id => document.getElementById(id);
  let savedUrl = '',
    savedToken = '',
    refreshId = 0;
  DraftStorage.get('sync', {
    apiUrl: '',
    apiTokens: '',
    memosVersion: '',
    hidetag: '',
    showtag: '',
    userName: ''
  }).then(info => {
    savedUrl = info.apiUrl;
    savedToken = info.apiTokens;
    el('apiUrl').value = savedUrl;
    if (savedToken) el('apiTokens').placeholder = uiMessage('modelSavedKey');
    el('hideInput').value = info.hidetag;
    el('showInput').value = info.showtag;
    el('connectionStatus').textContent = [info.userName, info.memosVersion && 'Memos ' + info.memosVersion]
      .filter(Boolean)
      .join(' · ');
  });
  el('connectionForm').onsubmit = async event => {
    event.preventDefault();
    const apiUrl = MemosAPI.normalizeBaseUrl(el('apiUrl').value);
    const apiTokens =
      el('apiTokens').value.trim() || (apiUrl === MemosAPI.normalizeBaseUrl(savedUrl) ? savedToken : '');
    const status = el('connectionStatus');
    if (!apiTokens) {
      status.textContent = uiMessage('placeApiTokens');
      el('apiTokens').focus();
      return;
    }
    el('saveKey').disabled = true;
    status.textContent = uiMessage('working');
    try {
      const user = await MemosAPI.currentUser(apiUrl, apiTokens);
      const profile = await MemosAPI.getInstanceProfile({ apiUrl, apiTokens }).catch(() => ({ version: '' }));
      await DraftStorage.put('sync', {
        apiUrl,
        apiTokens,
        userName: user.userName,
        userid: user.userId,
        memosVersion: profile.version
      });
      savedUrl = apiUrl;
      savedToken = apiTokens;
      el('apiTokens').value = '';
      el('apiTokens').placeholder = uiMessage('modelSavedKey');
      status.textContent = [uiMessage('settingsSaved'), user.userName, profile.version && 'Memos ' + profile.version]
        .filter(Boolean)
        .join(' · ');
    } catch (error) {
      status.textContent = uiMessage(
        error.status === 401 ? 'invalidToken' : error.code === 'invalid_url' ? 'invalidUrl' : 'apiFailed'
      );
    } finally {
      el('saveKey').disabled = false;
    }
  };
  el('saveAI').onclick = () => {
    cacheCurrentProviderForm();
    persistLLMState(error => {
      el('aiSettingsStatus').textContent = uiMessage(
        !error ? 'settingsSaved' : error.message === 'aiMaxTokensInvalid' ? 'aiMaxTokensInvalid' : 'settingsSaveFailed'
      );
    });
  };
  el('saveTag').onclick = async () => {
    try {
      el('hideInput').value = MemoTags.normalize(el('hideInput').value);
      el('showInput').value = MemoTags.normalize(el('showInput').value);
      await DraftStorage.put('sync', { hidetag: el('hideInput').value, showtag: el('showInput').value });
      $.message({ message: uiMessage('settingsSaved') });
    } catch (_) {
      $.message({ message: uiMessage('settingsSaveFailed') });
    }
  };
  el('refreshModels').onclick = async () => {
    const attempt = ++refreshId,
      provider = el('llmProvider').value;
    const status = el('modelStatus'),
      button = el('refreshModels');
    button.disabled = true;
    status.textContent = uiMessage('working');
    try {
      const count = await ModelCatalog.refresh(provider, getCurrentFormConfig(provider));
      if (attempt !== refreshId) return;
      rebuildModelChoices(provider);
      status.textContent = uiMessage('modelCount').replace('{n}', count);
    } catch (error) {
      if (attempt === refreshId)
        status.textContent = error.status
          ? extractLLMErrorMessage(error)
          : uiMessage(['aiApiKeyRequired', 'modelGatewayUrl'].includes(error.message) ? error.message : 'modelInvalid');
    } finally {
      if (attempt === refreshId) button.disabled = false;
    }
  };
  const cancelRefresh = () => {
    refreshId++;
    el('refreshModels').disabled = false;
    el('modelStatus').textContent = '';
    el('aiSettingsStatus').textContent = '';
  };
  el('llmProvider').addEventListener('change', cancelRefresh);
  for (const id of ['llmApiKey', 'llmBaseUrl'])
    el(id).addEventListener('input', () => {
      cancelRefresh();
      ModelCatalog.invalidate(el('llmProvider').value);
      rebuildModelChoices(el('llmProvider').value);
    });
});
