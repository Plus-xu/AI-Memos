/* global AIReview, AIWorkflow, Clipper, LLM_CONFIG, ModelCatalog, memoSaveInProgress, uiMessage */
/* exported persistLLMState */
/**
 * AI优化功能实现
 * 负责LLM配置管理和内容优化
 */

const LLM_QUICK_PRESET_LIMIT = 3;
let llmProviderConfigs = {};
let llmActiveProvider = LLM_CONFIG.defaults.provider;
let llmQuickPresets = [];
let llmMessagesOverride = null;
let llmMaxOutputTokens = 0;

function normalizeMaxOutputTokens(value) {
  const limit = typeof value === 'string' && value.trim() ? Number(value) : value;
  return Number.isInteger(limit) && limit >= 256 && limit <= 200000 ? limit : 0;
}

// Gateways front models with different ceilings, so New API sends no limit unless one is configured.
function outputTokenLimit(providerConfig) {
  return llmMaxOutputTokens || (providerConfig.requiresBaseUrl ? 0 : LLM_CONFIG.defaults.maxTokens);
}

function getLLMMessage(key, fallback) {
  if (llmMessagesOverride && llmMessagesOverride[key]) {
    return llmMessagesOverride[key].message;
  }

  return (typeof uiMessage === 'function' ? uiMessage(key) : chrome.i18n.getMessage(key)) || fallback || '';
}

function isValidProvider(provider) {
  return !!LLM_CONFIG.providers[provider];
}

function getProviderDefaultModel(provider) {
  const providerConfig = LLM_CONFIG.providers[provider];
  if (!providerConfig || !providerConfig.models || providerConfig.models.length === 0) {
    return LLM_CONFIG.defaults.model;
  }
  if (provider === LLM_CONFIG.defaults.provider) {
    return LLM_CONFIG.defaults.model;
  }
  return providerConfig.models[0].value;
}

function getProviderModelValues(provider) {
  const providerConfig = LLM_CONFIG.providers[provider];
  if (!providerConfig || !providerConfig.models) {
    return [];
  }
  const legacy = {
    openai: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4.1'],
    deepseek: ['deepseek-v4-flash']
  };
  return providerConfig.models
    .map(model => model.value)
    .concat(legacy[provider] || [], typeof ModelCatalog === 'undefined' ? [] : ModelCatalog.list(provider));
}

function normalizeProviderConfig(provider, config) {
  const modelValues = getProviderModelValues(provider);
  let model = config && config.model ? config.model : getProviderDefaultModel(provider);
  let customModel = config && config.customModel ? config.customModel : '';

  if (modelValues.indexOf(model) === -1) {
    if (modelValues.indexOf('custom') !== -1) {
      customModel = customModel || model;
      model = 'custom';
    } else {
      model = getProviderDefaultModel(provider);
    }
  }

  return {
    model: model,
    customModel: model === 'custom' ? customModel : '',
    apiKey: config && config.apiKey ? config.apiKey : '',
    baseUrl: config && config.baseUrl ? config.baseUrl : ''
  };
}

function normalizeQuickPresets(presets) {
  const normalized = Array.isArray(presets) ? presets.slice(0, LLM_QUICK_PRESET_LIMIT) : [];
  while (normalized.length < LLM_QUICK_PRESET_LIMIT) {
    normalized.push({});
  }

  return normalized.map(function (preset) {
    if (!preset || !isValidProvider(preset.provider)) {
      return {};
    }

    const config = normalizeProviderConfig(preset.provider, {
      model: preset.model,
      customModel: preset.customModel
    });

    return {
      provider: preset.provider,
      model: config.model,
      customModel: config.customModel,
      name: typeof preset.name === 'string' ? preset.name.slice(0, 64) : '',
      task: AIWorkflow.normalizeTask(preset.task),
      prompt: typeof preset.prompt === 'string' ? preset.prompt.slice(0, 8000) : ''
    };
  });
}

function getCurrentFormConfig(providerOverride) {
  const provider = providerOverride || $('#llmProvider').val();
  return normalizeProviderConfig(provider, {
    model: $('#llmModel').val(),
    customModel: $('#llmCustomModel').val(),
    apiKey: $('#llmApiKey').val(),
    baseUrl: $('#llmBaseUrl').val()
  });
}

function cacheCurrentProviderForm(providerOverride) {
  const provider = providerOverride || $('#llmProvider').val();
  if (!isValidProvider(provider)) {
    return;
  }

  llmProviderConfigs[provider] = getCurrentFormConfig(provider);
  llmActiveProvider = provider;
}

function applyModelSelection($modelSelect, $customInput, provider, model, customModel) {
  const config = normalizeProviderConfig(provider, {
    model: model,
    customModel: customModel
  });

  if (
    config.model === 'custom' &&
    typeof ModelCatalog !== 'undefined' &&
    ModelCatalog.list(provider).includes(config.customModel)
  ) {
    config.model = config.customModel;
    config.customModel = '';
  }
  if (
    config.model !== 'custom' &&
    !$modelSelect
      .find('option')
      .toArray?.()
      .some(option => option.value === config.model)
  ) {
    $modelSelect.append($('<option></option>').val(config.model).text(config.model));
  }
  $modelSelect.val(config.model);
  if (config.model === 'custom') {
    $customInput.val(config.customModel).show();
  } else {
    $customInput.val('').hide();
  }
}

function applyProviderConfigToForm(provider) {
  const config = normalizeProviderConfig(provider, llmProviderConfigs[provider]);

  $('#llmProvider').val(provider);
  updateModelList(provider, $('#llmModel'));
  applyModelSelection($('#llmModel'), $('#llmCustomModel'), provider, config.model, config.customModel);
  $('#llmApiKey').val(config.apiKey);
  $('#llmBaseUrl').val(config.baseUrl);
  updateBaseUrlVisibility(provider);
}

function buildLegacyConfig(data) {
  const provider = isValidProvider(data.llmProvider) ? data.llmProvider : LLM_CONFIG.defaults.provider;
  const hasLegacyConfig = data.llmProvider || data.llmModel || data.llmCustomModel || data.llmApiKey || data.llmBaseUrl;

  if (!hasLegacyConfig) {
    return null;
  }

  return {
    provider: provider,
    config: normalizeProviderConfig(provider, {
      model: data.llmModel,
      customModel: data.llmCustomModel,
      apiKey: data.llmApiKey,
      baseUrl: data.llmBaseUrl
    })
  };
}

function loadLLMState(callback) {
  const keys = [
    'llmProviderConfigs',
    'llmActiveProvider',
    'llmQuickPresets',
    'llmMaxOutputTokens',
    'llmProvider',
    'llmModel',
    'llmCustomModel',
    'llmApiKey',
    'llmBaseUrl'
  ];

  chrome.storage.sync.get(keys, function (data) {
    chrome.storage.local.get({ llmTaskPresets: null }, function (local) {
      if (Array.isArray(local.llmTaskPresets)) data.llmQuickPresets = local.llmTaskPresets;
      llmProviderConfigs = data.llmProviderConfigs || {};
      llmMaxOutputTokens = normalizeMaxOutputTokens(data.llmMaxOutputTokens);
      const legacyConfig = buildLegacyConfig(data);

      if (legacyConfig && !llmProviderConfigs[legacyConfig.provider]) {
        llmProviderConfigs[legacyConfig.provider] = legacyConfig.config;
      }

      Object.keys(LLM_CONFIG.providers).forEach(function (provider) {
        if (llmProviderConfigs[provider]) {
          llmProviderConfigs[provider] = normalizeProviderConfig(provider, llmProviderConfigs[provider]);
        }
      });

      llmActiveProvider =
        data.llmActiveProvider || (legacyConfig && legacyConfig.provider) || LLM_CONFIG.defaults.provider;
      if (!isValidProvider(llmActiveProvider)) {
        llmActiveProvider = LLM_CONFIG.defaults.provider;
      }

      if (!llmProviderConfigs[llmActiveProvider]) {
        llmProviderConfigs[llmActiveProvider] = normalizeProviderConfig(llmActiveProvider, {});
      }

      llmQuickPresets = normalizeQuickPresets(data.llmQuickPresets);

      // Compatibility reads do not change stored settings until explicitly saved.

      if (typeof callback === 'function') {
        callback();
      }
    });
  });
}

function persistLLMState(callback) {
  const activeConfig = normalizeProviderConfig(llmActiveProvider, llmProviderConfigs[llmActiveProvider]);
  const presets = collectQuickPresetConfigs();
  llmQuickPresets = presets;
  const limitField = document.getElementById('llmMaxTokens');
  if (limitField) {
    const limit = normalizeMaxOutputTokens(limitField.value);
    if (!limit && (String(limitField.value).trim() || (limitField.validity && limitField.validity.badInput))) {
      if (callback) callback(new Error('aiMaxTokensInvalid'));
      else $.message({ message: getLLMMessage('aiMaxTokensInvalid') });
      return;
    }
    llmMaxOutputTokens = limit;
    limitField.value = llmMaxOutputTokens || '';
  }

  chrome.storage.local.set({ llmTaskPresets: presets }, function () {
    if (chrome.runtime.lastError) {
      if (callback) callback(chrome.runtime.lastError);
      else $.message({ message: getLLMMessage('draftSaveFailed') });
      return;
    }
    chrome.storage.sync.set(
      {
        llmProviderConfigs: llmProviderConfigs,
        llmActiveProvider: llmActiveProvider,
        llmMaxOutputTokens: llmMaxOutputTokens,
        llmQuickPresets: presets.map(function (preset) {
          return preset.provider
            ? { provider: preset.provider, model: preset.model, customModel: preset.customModel }
            : {};
        }),
        // Keep legacy keys in sync for older extension versions.
        llmProvider: llmActiveProvider,
        llmModel: activeConfig.model,
        llmCustomModel: activeConfig.customModel,
        llmApiKey: activeConfig.apiKey,
        llmBaseUrl: activeConfig.baseUrl
      },
      () => {
        const error = chrome.runtime.lastError;
        if (callback) callback(error);
        else if (error) $.message({ message: getLLMMessage('settingsSaveFailed') });
      }
    );
  });
}

// 初始化LLM配置界面
function initLLMConfig() {
  loadLLMState(function () {
    applyProviderConfigToForm(llmActiveProvider);
    $('#llmMaxTokens').val(llmMaxOutputTokens || '');
    initQuickPresetControls();
    if (typeof ModelCatalog !== 'undefined' && document.getElementById('llmProvider')) restoreModelChoices();
    refreshLLMTexts();
  });

  $('#llmProvider').change(function () {
    const previousProvider = llmActiveProvider;
    if (isValidProvider(previousProvider)) {
      llmProviderConfigs[previousProvider] = getCurrentFormConfig(previousProvider);
    }

    const provider = $(this).val();
    llmActiveProvider = provider;
    $('#modelStatus').text('');
    if (!llmProviderConfigs[provider]) {
      llmProviderConfigs[provider] = normalizeProviderConfig(provider, {});
    }
    applyProviderConfigToForm(provider);
  });

  $('#llmModel').change(function () {
    toggleCustomModel($('#llmModel'), $('#llmCustomModel'));
  });
}

// 更新模型列表
function updateModelList(provider, $modelSelect) {
  const $select = $modelSelect || $('#llmModel');
  $select.empty();

  const item = LLM_CONFIG.providers[provider];
  if (!item) return;
  function addGroup(label, models) {
    if (!models.length) return;
    const group = $('<optgroup></optgroup>').attr('label', getLLMMessage(label));
    for (const model of models) group.append($('<option></option>').val(model.value).text(model.label));
    $select.append(group);
  }
  addGroup(
    'modelRecommended',
    item.models.filter(model => model.value !== 'custom')
  );
  const listed = typeof ModelCatalog === 'undefined' ? [] : ModelCatalog.list(provider);
  addGroup(
    'modelAccount',
    listed.filter(id => !item.models.some(m => m.value === id)).map(value => ({ value, label: value }))
  );
  $select.append($('<option></option>').val('custom').text(getLLMMessage('modelCustom')));
}

function rebuildModelChoices(provider) {
  if ($('#llmProvider').val() === provider) {
    const model = $('#llmModel').val(),
      custom = $('#llmCustomModel').val();
    updateModelList(provider);
    applyModelSelection($('#llmModel'), $('#llmCustomModel'), provider, model, custom);
  }
  $('.quick-preset-row').each(function () {
    const row = $(this);
    if (row.find('.quick-preset-provider').val() === provider)
      populateQuickPresetModelSelect(
        row,
        provider,
        row.find('.quick-preset-model').val(),
        row.find('.quick-preset-custom-model').val()
      );
  });
}

async function restoreModelChoices() {
  await Promise.all(
    Object.entries(llmProviderConfigs).map(async ([provider, config]) => {
      if (isValidProvider(provider)) {
        await ModelCatalog.restore(provider, config);
        rebuildModelChoices(provider);
      }
    })
  );
}

function toggleCustomModel($modelSelect, $customInput) {
  const model = $modelSelect.val();
  if (model === 'custom') {
    $customInput.show();
  } else {
    $customInput.hide().val('');
  }
}

function getProviderDisplayName(provider) {
  return LLM_CONFIG.providers[provider] ? LLM_CONFIG.providers[provider].name : provider;
}

function getModelDisplayName(provider, model, customModel) {
  if (model === 'custom') {
    return customModel || getLLMMessage('llmCustomModelPlaceholder', 'Custom model');
  }

  const providerConfig = LLM_CONFIG.providers[provider];
  if (!providerConfig || !providerConfig.models) {
    return model || '';
  }

  const matchedModel = providerConfig.models.find(function (item) {
    return item.value === model;
  });

  return matchedModel ? matchedModel.label : model;
}

function getPresetLabel(preset, index) {
  if (!preset || !preset.provider) {
    return getLLMMessage('llmQuickPresetEmpty', 'Not set') || 'Preset ' + (index + 1);
  }

  const modelLabel = getModelDisplayName(preset.provider, preset.model, preset.customModel);
  const taskLabel = getLLMMessage('aiTask_' + AIWorkflow.normalizeTask(preset.task));
  return (
    (preset.name && preset.name !== taskLabel ? preset.name + ' · ' : '') +
    taskLabel +
    ' · ' +
    getProviderDisplayName(preset.provider) +
    ' / ' +
    modelLabel
  );
}

function collectQuickPresetConfigs() {
  const $rows = $('.quick-preset-row');
  if ($rows.length === 0) {
    return normalizeQuickPresets(llmQuickPresets);
  }

  const presets = [];
  $rows.each(function () {
    const $row = $(this);
    const provider = $row.find('.quick-preset-provider').val();
    if (!provider || !isValidProvider(provider)) {
      presets.push({});
      return;
    }

    const model = $row.find('.quick-preset-model').val();
    const customModel = $row.find('.quick-preset-custom-model').val();
    const config = normalizeProviderConfig(provider, {
      model: model,
      customModel: customModel
    });

    presets.push({
      provider: provider,
      model: config.model,
      customModel: config.customModel,
      name: $row.find('.quick-preset-label').val(),
      task: $row.find('.quick-preset-task').val(),
      prompt: $row.find('.quick-preset-prompt').val()
    });
  });

  return normalizeQuickPresets(presets);
}

function populateProviderSelect($select, selectedProvider, includeEmpty) {
  $select.empty();
  if (includeEmpty) {
    $select.append(`<option value="">${getLLMMessage('llmQuickPresetEmpty', 'Not set')}</option>`);
  }

  Object.keys(LLM_CONFIG.providers).forEach(function (provider) {
    $select.append(`<option value="${provider}">${getProviderDisplayName(provider)}</option>`);
  });

  $select.val(selectedProvider || '');
}

function populateQuickPresetModelSelect($row, provider, selectedModel, customModel) {
  const $modelSelect = $row.find('.quick-preset-model');
  const $customInput = $row.find('.quick-preset-custom-model');

  if (!provider || !isValidProvider(provider)) {
    $modelSelect.empty().prop('disabled', true);
    $customInput.hide().val('');
    return;
  }

  $modelSelect.prop('disabled', false);
  updateModelList(provider, $modelSelect);
  applyModelSelection($modelSelect, $customInput, provider, selectedModel, customModel);
}

function buildQuickPresetRows() {
  const $container = $('#quickPresetRows');
  $container.empty();

  llmQuickPresets = normalizeQuickPresets(llmQuickPresets);

  for (let index = 0; index < LLM_QUICK_PRESET_LIMIT; index++) {
    const preset = llmQuickPresets[index] || {};
    const $row = $('<div class="quick-preset-row"></div>');
    const $name = $('<span class="quick-preset-name"></span>');
    const $providerSelect = $('<select class="inputer quick-preset-provider"></select>');
    const $modelSelect = $('<select class="inputer quick-preset-model"></select>');
    const $customInput = $(
      '<input class="inputer quick-preset-custom-model" type="text" maxlength="100" style="display: none;" />'
    );
    const $label = $('<input class="inputer quick-preset-label" type="text" maxlength="64" />');
    const $task = $('<select class="inputer quick-preset-task"></select>');
    const $prompt = $('<textarea class="quick-preset-prompt" rows="3" maxlength="8000"></textarea>');
    $label.val(preset.name || '').attr('aria-label', getLLMMessage('aiPresetName'));
    AIWorkflow.tasks.forEach(function (task) {
      $task.append(
        $('<option></option>')
          .val(task)
          .text(getLLMMessage('aiTask_' + task))
      );
    });
    $task.val(AIWorkflow.normalizeTask(preset.task)).attr('aria-label', getLLMMessage('aiTaskLabel'));
    $prompt
      .val(preset.prompt || '')
      .attr('aria-label', getLLMMessage('aiCustomPrompt'))
      .prop('hidden', preset.task !== 'custom');

    $name.text(getLLMMessage('llmQuickPresetPrefix', 'Quick') + ' ' + (index + 1));
    $customInput.attr('placeholder', getLLMMessage('llmCustomModelPlaceholder', 'Custom model'));

    $row.append($name, $providerSelect, $modelSelect, $customInput, $label, $task, $prompt);
    $container.append($row);

    populateProviderSelect($providerSelect, preset.provider, true);
    populateQuickPresetModelSelect($row, preset.provider, preset.model, preset.customModel);
  }
}

function refreshQuickPresetRowLabels() {
  $('.quick-preset-name').each(function (index) {
    $(this).text(getLLMMessage('llmQuickPresetPrefix', 'Quick') + ' ' + (index + 1));
  });
}

function updateQuickPresetMenu() {
  const $menu = $('#quickItems');
  if ($menu.length === 0) {
    return;
  }

  $menu.empty();
  llmQuickPresets = normalizeQuickPresets(collectQuickPresetConfigs());

  llmQuickPresets.forEach(function (preset, index) {
    const $item = $('<button type="button" class="ai-quick-item"></button>');
    $item.attr('data-index', index);

    if (!preset.provider) {
      $item.prop('disabled', true).text(index + 1 + '. ' + getLLMMessage('llmQuickPresetEmpty', 'Not set'));
    } else {
      $item.text(index + 1 + '. ' + getPresetLabel(preset, index));
    }

    $menu.append($item);
  });
}

function refreshLLMTexts(messages) {
  if (messages) {
    llmMessagesOverride = messages;
  }

  $('#llmQuickPresetsLabel').text(getLLMMessage('llmQuickPresetsLabel', 'Quick presets'));
  ['llmProviderLabel', 'llmModelLabel', 'llmApiKeyLabel', 'llmBaseUrlLabel'].forEach(function (id) {
    $('#' + id).text(getLLMMessage(id));
  });
  $('#ai_quick_toggle').attr('title', getLLMMessage('llmQuickPresetMenuTooltip', 'Quick AI presets'));
  $('.quick-preset-provider option[value=""]').text(getLLMMessage('llmQuickPresetEmpty', 'Not set'));
  $('.quick-preset-label')
    .attr('placeholder', getLLMMessage('aiPresetName'))
    .attr('aria-label', getLLMMessage('aiPresetName'));
  $('.quick-preset-task').attr('aria-label', getLLMMessage('aiTaskLabel'));
  $('.quick-preset-task').each(function () {
    $(this)
      .find('option')
      .each(function () {
        $(this).text(getLLMMessage('aiTask_' + this.value));
      });
  });
  $('.quick-preset-prompt')
    .attr('placeholder', getLLMMessage('aiCustomPrompt'))
    .attr('aria-label', getLLMMessage('aiCustomPrompt'));
  AIReview.refreshTexts();
  refreshQuickPresetRowLabels();
  updatePlaceholders();
  updateQuickPresetMenu();
}

function initQuickPresetControls() {
  buildQuickPresetRows();
  refreshLLMTexts();

  $('#quickPresetRows').on('change', '.quick-preset-provider', function () {
    const $row = $(this).closest('.quick-preset-row');
    const provider = $(this).val();
    populateQuickPresetModelSelect($row, provider, null, '');
    llmQuickPresets = normalizeQuickPresets(collectQuickPresetConfigs());
    updateQuickPresetMenu();
  });

  $('#quickPresetRows').on('change', '.quick-preset-model', function () {
    const $row = $(this).closest('.quick-preset-row');
    toggleCustomModel($row.find('.quick-preset-model'), $row.find('.quick-preset-custom-model'));
    llmQuickPresets = normalizeQuickPresets(collectQuickPresetConfigs());
    updateQuickPresetMenu();
  });

  $('#quickPresetRows').on('input', '.quick-preset-custom-model', function () {
    llmQuickPresets = normalizeQuickPresets(collectQuickPresetConfigs());
    updateQuickPresetMenu();
  });

  $('#quickPresetRows').on(
    'input change',
    '.quick-preset-label, .quick-preset-task, .quick-preset-prompt',
    function () {
      const $row = $(this).closest('.quick-preset-row');
      $row.find('.quick-preset-prompt').prop('hidden', $row.find('.quick-preset-task').val() !== 'custom');
      llmQuickPresets = normalizeQuickPresets(collectQuickPresetConfigs());
      chrome.storage.local.set({ llmTaskPresets: llmQuickPresets }, function () {
        if (chrome.runtime.lastError) $.message({ message: getLLMMessage('draftSaveFailed') });
      });
      updateQuickPresetMenu();
    }
  );

  $('#ai_quick_toggle').click(function (e) {
    e.preventDefault();
    updateQuickPresetMenu();
    $('#ai_quick_menu').toggleClass('hidden');
    $(this).attr('aria-expanded', !$('#ai_quick_menu').hasClass('hidden'));
  });

  $('#ai_quick_menu').on('click', '.ai-quick-item', function (e) {
    e.preventDefault();
    const index = Number($(this).attr('data-index'));
    const preset = collectQuickPresetConfigs()[index];
    $('#ai_quick_menu').addClass('hidden');

    if (!preset || !preset.provider) {
      $.message({ message: getLLMMessage('llmQuickPresetNotConfigured', 'Quick preset is not configured') });
      return;
    }

    optimizeWithAI(preset, $('#ai_optimize'));
  });

  $(document).click(function (e) {
    if ($(e.target).closest('.ai-split-wrapper').length === 0) {
      $('#ai_quick_menu').addClass('hidden');
    }
  });
}

// 根据提供商切换 Base URL 输入框
function updateBaseUrlVisibility(provider) {
  const requiresBaseUrl = LLM_CONFIG.providers[provider] && LLM_CONFIG.providers[provider].requiresBaseUrl;
  $('#llmBaseUrlLabel').toggle(!!requiresBaseUrl);
  $('#llmBaseUrl').toggle(!!requiresBaseUrl);
}

// 更新占位符文本
function updatePlaceholders() {
  $('#llmCustomModel').attr('placeholder', getLLMMessage('llmCustomModelPlaceholder'));
  $('#llmApiKey').attr('placeholder', getLLMMessage('llmApiKeyPlaceholder'));
  $('#llmBaseUrl').attr('placeholder', getLLMMessage('llmBaseUrlPlaceholder'));
  $('.quick-preset-custom-model').attr('placeholder', getLLMMessage('llmCustomModelPlaceholder'));
}

// 获取语言输出指令
function getLanguageInstruction(languageCode) {
  const languageMap = {
    zh_CN: {
      name: '简体中文',
      instruction:
        '# 输出语言要求\n\n⚠️ **重要**：你必须使用**简体中文（Simplified Chinese）**输出所有内容。\n\n- 所有文字说明、标题、列表项都使用简体中文\n- 标签使用简体中文：#工作 #学习 #生活\n- 即使用户输入是英文或其他语言，也必须翻译成简体中文输出\n- 保留原文中的专有名词、品牌名、代码、链接等无需翻译的内容'
    },
    en: {
      name: 'English',
      instruction:
        '# Output Language Requirement\n\n⚠️ **Important**: You MUST output ALL content in **English**.\n\n- All text descriptions, titles, and list items must be in English\n- Tags must be in English: #work #study #life\n- Even if user input is in Chinese or other languages, translate it to English\n- Preserve proper nouns, brand names, code, links, and other content that should not be translated'
    },
    ja: {
      name: '日本語',
      instruction:
        '# 出力言語の要件\n\n⚠️ **重要**：すべてのコンテンツを**日本語（Japanese）**で出力する必要があります。\n\n- すべてのテキスト説明、タイトル、リスト項目は日本語で記述してください\n- タグは日本語で：#仕事 #勉強 #生活\n- ユーザー入力が中国語や英語であっても、日本語に翻訳して出力してください\n- 固有名詞、ブランド名、コード、リンクなど、翻訳すべきでない内容はそのまま保持してください'
    }
  };

  const languageInfo = languageMap[languageCode] || languageMap['en'];

  return languageInfo.instruction;
}

function getFallbackUserLanguage() {
  const browserLang = chrome.i18n.getUILanguage();
  if (browserLang.startsWith('zh')) {
    return 'zh_CN';
  }
  if (browserLang.startsWith('ja')) {
    return 'ja';
  }
  return 'en';
}

function resolveOptimizationConfig(preset) {
  cacheCurrentProviderForm();

  const provider = preset && preset.provider ? preset.provider : llmActiveProvider;
  if (!isValidProvider(provider)) {
    throw new Error(getLLMMessage('aiNotConfigured'));
  }

  const savedProviderConfig = normalizeProviderConfig(provider, llmProviderConfigs[provider]);
  const modelConfig =
    preset && preset.provider
      ? normalizeProviderConfig(provider, {
          model: preset.model,
          customModel: preset.customModel,
          apiKey: savedProviderConfig.apiKey,
          baseUrl: savedProviderConfig.baseUrl
        })
      : savedProviderConfig;

  let modelName = modelConfig.model;
  if (modelConfig.model === 'custom') {
    modelName = modelConfig.customModel;
  }

  if (!modelName || modelName.trim() === '') {
    throw new Error(getLLMMessage('aiNotConfigured'));
  }

  if (!modelConfig.apiKey || modelConfig.apiKey.trim() === '') {
    throw new Error(getLLMMessage('aiApiKeyRequired'));
  }

  const providerConfig = LLM_CONFIG.providers[provider];
  if (providerConfig.requiresBaseUrl && (!modelConfig.baseUrl || modelConfig.baseUrl.trim() === '')) {
    throw new Error(getLLMMessage('aiBaseUrlRequired', 'Please enter Base URL'));
  }

  return {
    provider: provider,
    model: modelName,
    apiKey: modelConfig.apiKey,
    baseUrl: modelConfig.baseUrl,
    task: AIWorkflow.normalizeTask((preset && preset.task) || $('#aiTask').val()),
    prompt: (preset && preset.prompt) || ''
  };
}

function setAIButtonLoading($button, isLoading) {
  const $targetButton = $button && $button.length ? $button : $('#ai_optimize');
  $('#ai_optimize, #ai_quick_toggle').prop('disabled', isLoading);
  $targetButton.toggleClass('loading', isLoading);
}

// AI优化功能
function optimizeWithAI(preset, $button) {
  if (AIReview.isBusy() || (typeof memoSaveInProgress !== 'undefined' && memoSaveInProgress)) return;
  const content = $('#content').val();

  // 验证内容
  if (!content || content.trim() === '') {
    $.message({
      message: getLLMMessage('aiNoContent')
    });
    return;
  }

  let optimizationConfig;
  try {
    optimizationConfig = resolveOptimizationConfig(preset);
    if (optimizationConfig.task === 'custom' && !optimizationConfig.prompt.trim()) {
      throw new Error(getLLMMessage('aiCustomPromptRequired'));
    }
  } catch (error) {
    $.message({
      message: error.message
    });
    return;
  }

  AIReview.setBusy(true, optimizationConfig.task);
  setAIButtonLoading($button, true);
  const run = () =>
    new Promise((resolve, reject) => {
      chrome.storage.sync.get(['userLanguage'], data => {
        if (chrome.runtime.lastError) {
          reject(new Error(getLLMMessage('aiInterrupted')));
          return;
        }
        $.message({ message: getLLMMessage('aiOptimizing') });
        callLLMAPI(
          optimizationConfig.provider,
          optimizationConfig.model,
          optimizationConfig.apiKey,
          content,
          data.userLanguage || getFallbackUserLanguage(),
          optimizationConfig.baseUrl,
          optimizationConfig.task,
          optimizationConfig.prompt
        ).then(result => {
          AIReview.show(content, result.text, optimizationConfig.task, result.truncated);
          $.message({ message: getLLMMessage(result.truncated ? 'aiTruncatedWarning' : 'aiReviewReady') });
          resolve();
        }, reject);
      });
    });
  return AIReview.withJob(optimizationConfig.task, run)
    .catch(error => {
      $.message({ message: getLLMMessage('aiOptimizeFailed') + ' · ' + error.message });
    })
    .finally(() => {
      AIReview.setBusy(false);
      setAIButtonLoading($button, false);
    });
}

function normalizeProviderBaseUrl(baseUrl) {
  return ModelCatalog.gateway(baseUrl);
}

function buildOpenAIResponsesRequest(providerConfig, model, apiKey, systemPrompt, userContent) {
  return {
    url: providerConfig.apiUrl,
    headers: {
      Authorization: 'Bearer ' + apiKey
    },
    body: {
      model: model,
      instructions: systemPrompt,
      input: userContent,
      max_output_tokens: outputTokenLimit(providerConfig)
    }
  };
}

function buildChatCompletionsRequest(providerConfig, model, apiKey, systemPrompt, userContent, baseUrl) {
  var apiUrl = providerConfig.apiUrl;
  if (providerConfig.requiresBaseUrl) {
    var normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    if (!normalizedBaseUrl) {
      throw new Error(chrome.i18n.getMessage('aiBaseUrlRequired') || 'Please enter Base URL');
    }
    apiUrl = normalizedBaseUrl + '/chat/completions';
  }

  return {
    url: apiUrl,
    headers: {
      Authorization: 'Bearer ' + apiKey
    },
    body: {
      model: model,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: userContent
        }
      ],
      ...(outputTokenLimit(providerConfig) ? { max_tokens: outputTokenLimit(providerConfig) } : {})
    }
  };
}

function buildGeminiRequest(providerConfig, model, apiKey, systemPrompt, userContent) {
  return {
    url: providerConfig.apiUrl.replace('{model}', encodeURIComponent(model)),
    headers: { 'x-goog-api-key': apiKey },
    body: {
      systemInstruction: {
        parts: [
          {
            text: systemPrompt
          }
        ]
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: userContent
            }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: outputTokenLimit(providerConfig)
      }
    }
  };
}

function buildAnthropicRequest(providerConfig, model, apiKey, systemPrompt, userContent) {
  return {
    url: providerConfig.apiUrl,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': providerConfig.anthropicVersion,
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: {
      model: model,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userContent
        }
      ],
      max_tokens: outputTokenLimit(providerConfig)
    }
  };
}

function buildLLMRequest(providerConfig, model, apiKey, systemPrompt, userContent, baseUrl) {
  if (providerConfig.endpointType === 'openai-responses') {
    return buildOpenAIResponsesRequest(providerConfig, model, apiKey, systemPrompt, userContent);
  }
  if (providerConfig.endpointType === 'chat-completions') {
    return buildChatCompletionsRequest(providerConfig, model, apiKey, systemPrompt, userContent, baseUrl);
  }
  if (providerConfig.endpointType === 'gemini') {
    return buildGeminiRequest(providerConfig, model, apiKey, systemPrompt, userContent);
  }
  if (providerConfig.endpointType === 'anthropic') {
    return buildAnthropicRequest(providerConfig, model, apiKey, systemPrompt, userContent);
  }

  throw new Error('未知的提供商类型');
}

function extractOpenAIResponsesText(response) {
  if (response.output_text) {
    return response.output_text;
  }

  if (Array.isArray(response.output)) {
    return response.output
      .flatMap(function (item) {
        return item.content || [];
      })
      .map(function (part) {
        return part.type === 'output_text' ? part.text || '' : '';
      })
      .filter(Boolean)
      .join('');
  }

  return '';
}

function extractChatCompletionsText(response) {
  if (response.choices && response.choices.length > 0 && response.choices[0].message) {
    const content = response.choices[0].message.content;
    if (Array.isArray(content))
      return content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('');
    return typeof content === 'string' ? content : '';
  }
  return '';
}

function extractGeminiText(response) {
  var candidate = response.candidates && response.candidates[0];
  var parts = candidate && candidate.content && candidate.content.parts;
  if (!Array.isArray(parts)) {
    return '';
  }
  return parts
    .map(function (part) {
      return part.thought ? '' : part.text || '';
    })
    .join('');
}

function extractAnthropicText(response) {
  if (!Array.isArray(response.content)) {
    return '';
  }
  return response.content
    .map(function (part) {
      return part.type === 'text' ? part.text || '' : '';
    })
    .join('');
}

function extractLLMText(providerConfig, response) {
  if (providerConfig.endpointType === 'openai-responses') {
    return extractOpenAIResponsesText(response);
  }
  if (providerConfig.endpointType === 'chat-completions') {
    return extractChatCompletionsText(response);
  }
  if (providerConfig.endpointType === 'gemini') {
    return extractGeminiText(response);
  }
  if (providerConfig.endpointType === 'anthropic') {
    return extractAnthropicText(response);
  }
  return '';
}

function extractLLMErrorMessage(xhr) {
  if (xhr.status === 401 || xhr.status === 403 || xhr.status === 404) return getLLMMessage('aiUnavailable');
  if (xhr.status === 429) return getLLMMessage('requestLimited');
  if (!xhr.status || xhr.statusText === 'timeout') return getLLMMessage('aiInterrupted');
  const body = xhr.responseJSON;
  const reason = body && ((body.error && body.error.message) || body.message);
  const detail =
    (xhr.status === 400 || xhr.status === 422) && typeof reason === 'string' ? reason.trim().slice(0, 240) : '';
  return getLLMMessage('apiFailed') + ' (HTTP ' + xhr.status + ')' + (detail ? ': ' + detail : '');
}

// 调用LLM API
function callLLMAPI(provider, model, apiKey, userContent, userLanguage, baseUrl, task, customPrompt) {
  return new Promise(function (resolve, reject) {
    const providerConfig = LLM_CONFIG.providers[provider];
    if (!providerConfig) {
      reject(new Error('未知的提供商'));
      return;
    }

    let systemPrompt;
    try {
      systemPrompt = AIWorkflow.buildPrompt(task, customPrompt, LLM_CONFIG.systemPrompt);
    } catch (error) {
      reject(error);
      return;
    }

    // 根据用户语言设置，添加输出语言指令
    const languageInstruction = getLanguageInstruction(userLanguage);
    systemPrompt = systemPrompt + '\n\n' + languageInstruction;

    let llmRequest;
    try {
      llmRequest = buildLLMRequest(providerConfig, model, apiKey, systemPrompt, userContent, baseUrl);
    } catch (error) {
      reject(error);
      return;
    }

    // 发送请求
    $.ajax({
      url: llmRequest.url,
      type: 'POST',
      contentType: 'application/json',
      dataType: 'json',
      headers: llmRequest.headers,
      data: JSON.stringify(llmRequest.body),
      timeout: 90000,
      success: function (response) {
        // 提取优化后的内容
        const finish =
          response.stop_reason || response.choices?.[0]?.finish_reason || response.candidates?.[0]?.finishReason;
        const truncated = ['max_tokens', 'length', 'MAX_TOKENS'].includes(finish) || response.status === 'incomplete';
        const optimizedContent = extractLLMText(providerConfig, response);
        if (typeof optimizedContent === 'string' && optimizedContent.trim()) {
          resolve({ text: optimizedContent, truncated: truncated });
        } else {
          reject(new Error(getLLMMessage(truncated ? 'aiTruncated' : 'aiEmpty')));
        }
      },
      error: function (xhr) {
        reject(new Error(extractLLMErrorMessage(xhr)));
      }
    });
  });
}

function llmStateChanged(changes, area) {
  return !!(
    (area === 'sync' && (changes.llmProviderConfigs || changes.llmActiveProvider || changes.llmMaxOutputTokens)) ||
    (area === 'local' && changes.llmTaskPresets)
  );
}

// 页面加载完成后初始化
$(document).ready(function () {
  // 初始化LLM配置界面
  initLLMConfig();
  if (document.getElementById('content')) AIReview.init();
  Clipper.init();
  if (!document.getElementById('llmProvider'))
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (llmStateChanged(changes, area)) loadLLMState(updateQuickPresetMenu);
    });

  // 绑定AI优化按钮点击事件
  $('#ai_optimize').click(function (e) {
    e.preventDefault();
    optimizeWithAI();
  });
});
