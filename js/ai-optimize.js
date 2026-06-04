/**
 * AI优化功能实现
 * 负责LLM配置管理和内容优化
 */

const LLM_QUICK_PRESET_LIMIT = 3;
let llmProviderConfigs = {};
let llmActiveProvider = LLM_CONFIG.defaults.provider;
let llmQuickPresets = [];
let llmMessagesOverride = null;

function getLLMMessage(key, fallback) {
  if (llmMessagesOverride && llmMessagesOverride[key]) {
    return llmMessagesOverride[key].message;
  }

  return chrome.i18n.getMessage(key) || fallback || '';
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
  return providerConfig.models.map(function(model) {
    return model.value;
  });
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

  return normalized.map(function(preset) {
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
      customModel: config.customModel
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
    'llmProvider',
    'llmModel',
    'llmCustomModel',
    'llmApiKey',
    'llmBaseUrl'
  ];

  chrome.storage.sync.get(keys, function(data) {
    llmProviderConfigs = data.llmProviderConfigs || {};
    const legacyConfig = buildLegacyConfig(data);
    let migrated = false;

    if (legacyConfig && !llmProviderConfigs[legacyConfig.provider]) {
      llmProviderConfigs[legacyConfig.provider] = legacyConfig.config;
      migrated = true;
    }

    Object.keys(LLM_CONFIG.providers).forEach(function(provider) {
      if (llmProviderConfigs[provider]) {
        llmProviderConfigs[provider] = normalizeProviderConfig(provider, llmProviderConfigs[provider]);
      }
    });

    llmActiveProvider = data.llmActiveProvider || (legacyConfig && legacyConfig.provider) || LLM_CONFIG.defaults.provider;
    if (!isValidProvider(llmActiveProvider)) {
      llmActiveProvider = LLM_CONFIG.defaults.provider;
    }

    if (!llmProviderConfigs[llmActiveProvider]) {
      llmProviderConfigs[llmActiveProvider] = normalizeProviderConfig(llmActiveProvider, {});
    }

    llmQuickPresets = normalizeQuickPresets(data.llmQuickPresets);

    if (migrated) {
      persistLLMState();
    }

    if (typeof callback === 'function') {
      callback();
    }
  });
}

function persistLLMState(callback) {
  const activeConfig = normalizeProviderConfig(llmActiveProvider, llmProviderConfigs[llmActiveProvider]);

  chrome.storage.sync.set({
    llmProviderConfigs: llmProviderConfigs,
    llmActiveProvider: llmActiveProvider,
    llmQuickPresets: collectQuickPresetConfigs(),
    // Keep legacy keys in sync for older extension versions.
    llmProvider: llmActiveProvider,
    llmModel: activeConfig.model,
    llmCustomModel: activeConfig.customModel,
    llmApiKey: activeConfig.apiKey,
    llmBaseUrl: activeConfig.baseUrl
  }, callback);
}

// 初始化LLM配置界面
function initLLMConfig() {
  loadLLMState(function() {
    applyProviderConfigToForm(llmActiveProvider);
    initQuickPresetControls();
    refreshLLMTexts();
  });

  $('#llmProvider').change(function() {
    const previousProvider = llmActiveProvider;
    if (isValidProvider(previousProvider)) {
      llmProviderConfigs[previousProvider] = getCurrentFormConfig(previousProvider);
    }

    const provider = $(this).val();
    llmActiveProvider = provider;
    if (!llmProviderConfigs[provider]) {
      llmProviderConfigs[provider] = normalizeProviderConfig(provider, {});
    }
    applyProviderConfigToForm(provider);
  });

  $('#llmModel').change(function() {
    toggleCustomModel($('#llmModel'), $('#llmCustomModel'));
  });
}

// 更新模型列表
function updateModelList(provider, $modelSelect) {
  const $select = $modelSelect || $('#llmModel');
  $select.empty();
  
  if (LLM_CONFIG.providers[provider]) {
    const models = LLM_CONFIG.providers[provider].models;
    models.forEach(function(model) {
      $select.append(`<option value="${model.value}">${model.label}</option>`);
    });
  }
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

  const matchedModel = providerConfig.models.find(function(item) {
    return item.value === model;
  });

  return matchedModel ? matchedModel.label : model;
}

function getPresetLabel(preset, index) {
  if (!preset || !preset.provider) {
    return getLLMMessage('llmQuickPresetEmpty', 'Not set') || ('Preset ' + (index + 1));
  }

  const modelLabel = getModelDisplayName(preset.provider, preset.model, preset.customModel);
  return getProviderDisplayName(preset.provider) + ' / ' + modelLabel;
}

function collectQuickPresetConfigs() {
  const $rows = $('.quick-preset-row');
  if ($rows.length === 0) {
    return normalizeQuickPresets(llmQuickPresets);
  }

  const presets = [];
  $rows.each(function() {
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
      customModel: config.customModel
    });
  });

  return normalizeQuickPresets(presets);
}

function populateProviderSelect($select, selectedProvider, includeEmpty) {
  $select.empty();
  if (includeEmpty) {
    $select.append(`<option value="">${getLLMMessage('llmQuickPresetEmpty', 'Not set')}</option>`);
  }

  Object.keys(LLM_CONFIG.providers).forEach(function(provider) {
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
    const $customInput = $('<input class="inputer quick-preset-custom-model" type="text" maxlength="100" style="display: none;" />');

    $name.text(getLLMMessage('llmQuickPresetPrefix', 'Quick') + ' ' + (index + 1));
    $customInput.attr('placeholder', getLLMMessage('llmCustomModelPlaceholder', 'Custom model'));

    $row.append($name, $providerSelect, $modelSelect, $customInput);
    $container.append($row);

    populateProviderSelect($providerSelect, preset.provider, true);
    populateQuickPresetModelSelect($row, preset.provider, preset.model, preset.customModel);
  }
}

function refreshQuickPresetRowLabels() {
  $('.quick-preset-name').each(function(index) {
    $(this).text(getLLMMessage('llmQuickPresetPrefix', 'Quick') + ' ' + (index + 1));
  });
}

function updateQuickPresetMenu() {
  const $menu = $('#ai_quick_menu');
  if ($menu.length === 0) {
    return;
  }

  $menu.empty();
  llmQuickPresets = normalizeQuickPresets(collectQuickPresetConfigs());

  llmQuickPresets.forEach(function(preset, index) {
    const $item = $('<button type="button" class="ai-quick-item"></button>');
    $item.attr('data-index', index);

    if (!preset.provider) {
      $item.prop('disabled', true).text((index + 1) + '. ' + getLLMMessage('llmQuickPresetEmpty', 'Not set'));
    } else {
      $item.text((index + 1) + '. ' + getPresetLabel(preset, index));
    }

    $menu.append($item);
  });
}

function refreshLLMTexts(messages) {
  if (messages) {
    llmMessagesOverride = messages;
  }

  $('#llmQuickPresetsLabel').text(getLLMMessage('llmQuickPresetsLabel', 'Quick presets'));
  $('#ai_quick_toggle').attr('title', getLLMMessage('llmQuickPresetMenuTooltip', 'Quick AI presets'));
  $('.quick-preset-provider option[value=""]').text(getLLMMessage('llmQuickPresetEmpty', 'Not set'));
  refreshQuickPresetRowLabels();
  updatePlaceholders();
  updateQuickPresetMenu();
}

function initQuickPresetControls() {
  buildQuickPresetRows();
  refreshLLMTexts();

  $('#quickPresetRows').on('change', '.quick-preset-provider', function() {
    const $row = $(this).closest('.quick-preset-row');
    const provider = $(this).val();
    populateQuickPresetModelSelect($row, provider, null, '');
    llmQuickPresets = normalizeQuickPresets(collectQuickPresetConfigs());
    updateQuickPresetMenu();
  });

  $('#quickPresetRows').on('change', '.quick-preset-model', function() {
    const $row = $(this).closest('.quick-preset-row');
    toggleCustomModel($row.find('.quick-preset-model'), $row.find('.quick-preset-custom-model'));
    llmQuickPresets = normalizeQuickPresets(collectQuickPresetConfigs());
    updateQuickPresetMenu();
  });

  $('#quickPresetRows').on('input', '.quick-preset-custom-model', function() {
    llmQuickPresets = normalizeQuickPresets(collectQuickPresetConfigs());
    updateQuickPresetMenu();
  });

  $('#ai_quick_toggle').click(function(e) {
    e.preventDefault();
    updateQuickPresetMenu();
    $('#ai_quick_menu').toggleClass('hidden');
  });

  $('#ai_quick_menu').on('click', '.ai-quick-item', function(e) {
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

  $(document).click(function(e) {
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

// 保存LLM配置（在原有保存按钮点击时调用）
function saveLLMConfig() {
  cacheCurrentProviderForm();
  llmQuickPresets = normalizeQuickPresets(collectQuickPresetConfigs());
  persistLLMState(updateQuickPresetMenu);
}

// 获取语言输出指令
function getLanguageInstruction(languageCode) {
  const languageMap = {
    'zh_CN': {
      name: '简体中文',
      instruction: '# 输出语言要求\n\n⚠️ **重要**：你必须使用**简体中文（Simplified Chinese）**输出所有内容。\n\n- 所有文字说明、标题、列表项都使用简体中文\n- 标签使用简体中文：#工作 #学习 #生活\n- 即使用户输入是英文或其他语言，也必须翻译成简体中文输出\n- 保留原文中的专有名词、品牌名、代码、链接等无需翻译的内容'
    },
    'en': {
      name: 'English',
      instruction: '# Output Language Requirement\n\n⚠️ **Important**: You MUST output ALL content in **English**.\n\n- All text descriptions, titles, and list items must be in English\n- Tags must be in English: #work #study #life\n- Even if user input is in Chinese or other languages, translate it to English\n- Preserve proper nouns, brand names, code, links, and other content that should not be translated'
    },
    'ja': {
      name: '日本語',
      instruction: '# 出力言語の要件\n\n⚠️ **重要**：すべてのコンテンツを**日本語（Japanese）**で出力する必要があります。\n\n- すべてのテキスト説明、タイトル、リスト項目は日本語で記述してください\n- タグは日本語で：#仕事 #勉強 #生活\n- ユーザー入力が中国語や英語であっても、日本語に翻訳して出力してください\n- 固有名詞、ブランド名、コード、リンクなど、翻訳すべきでない内容はそのまま保持してください'
    }
  };
  
  const languageInfo = languageMap[languageCode] || languageMap['en'];
  
  console.log('📝 AI输出语言:', languageInfo.name);
  
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
  const modelConfig = preset && preset.provider
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
    baseUrl: modelConfig.baseUrl
  };
}

function setAIButtonLoading($button, isLoading) {
  const $targetButton = $button && $button.length ? $button : $('#ai_optimize');
  $('.ai-btn').prop('disabled', isLoading);
  $targetButton.toggleClass('loading', isLoading);
}

// AI优化功能
function optimizeWithAI(preset, $button) {
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
  } catch (error) {
    $.message({
      message: error.message
    });
    return;
  }

  chrome.storage.sync.get(['userLanguage'], function(data) {
    const userLanguage = data.userLanguage || getFallbackUserLanguage();
    console.log('🌐 用户语言设置:', userLanguage);

    const $targetButton = $button && $button.length ? $button : $('#ai_optimize');
    setAIButtonLoading($targetButton, true);
    $.message({
      message: getLLMMessage('aiOptimizing')
    });

    callLLMAPI(
      optimizationConfig.provider,
      optimizationConfig.model,
      optimizationConfig.apiKey,
      content,
      userLanguage,
      optimizationConfig.baseUrl
    )
      .then(function(optimizedContent) {
        $('#content').val(optimizedContent);
        $.message({
          message: getLLMMessage('aiOptimizeSuccess')
        });
      })
      .catch(function(error) {
        console.error('AI优化失败:', error);
        $.message({
          message: getLLMMessage('aiOptimizeFailed') + ': ' + error.message
        });
      })
      .finally(function() {
        setAIButtonLoading($targetButton, false);
      });
  });
}

function normalizeProviderBaseUrl(baseUrl) {
  var normalized = (baseUrl || '').trim();
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function buildOpenAIResponsesRequest(providerConfig, model, apiKey, systemPrompt, userContent) {
  return {
    url: providerConfig.apiUrl,
    headers: {
      'Authorization': 'Bearer ' + apiKey
    },
    body: {
      model: model,
      instructions: systemPrompt,
      input: userContent,
      temperature: LLM_CONFIG.defaults.temperature,
      max_output_tokens: LLM_CONFIG.defaults.maxTokens
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
      'Authorization': 'Bearer ' + apiKey
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
      temperature: LLM_CONFIG.defaults.temperature,
      max_tokens: LLM_CONFIG.defaults.maxTokens
    }
  };
}

function buildGeminiRequest(providerConfig, model, apiKey, systemPrompt, userContent) {
  return {
    url: providerConfig.apiUrl.replace('{model}', encodeURIComponent(model)) + '?key=' + encodeURIComponent(apiKey),
    headers: {},
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
        temperature: LLM_CONFIG.defaults.temperature,
        maxOutputTokens: LLM_CONFIG.defaults.maxTokens
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
      max_tokens: LLM_CONFIG.defaults.maxTokens,
      temperature: LLM_CONFIG.defaults.temperature
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
        return part.text || '';
      })
      .filter(Boolean)
      .join('');
  }

  return '';
}

function extractChatCompletionsText(response) {
  if (response.choices && response.choices.length > 0 && response.choices[0].message) {
    return response.choices[0].message.content || '';
  }
  return '';
}

function extractGeminiText(response) {
  var candidate = response.candidates && response.candidates[0];
  var parts = candidate && candidate.content && candidate.content.parts;
  if (!Array.isArray(parts)) {
    return '';
  }
  return parts.map(function (part) {
    return part.text || '';
  }).join('');
}

function extractAnthropicText(response) {
  if (!Array.isArray(response.content)) {
    return '';
  }
  return response.content.map(function (part) {
    return part.text || '';
  }).join('');
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
  var responseJSON = xhr.responseJSON || {};
  if (responseJSON.error) {
    return responseJSON.error.message || responseJSON.error;
  }
  if (responseJSON.message) {
    return responseJSON.message;
  }
  if (xhr.status === 401) {
    return 'API密钥无效';
  }
  if (xhr.status === 429) {
    return '请求过于频繁，请稍后再试';
  }
  if (xhr.status >= 500) {
    return 'API服务器错误';
  }
  return xhr.responseText || '未知错误';
}

// 调用LLM API
function callLLMAPI(provider, model, apiKey, userContent, userLanguage, baseUrl) {
  return new Promise(function(resolve, reject) {
    const providerConfig = LLM_CONFIG.providers[provider];
    if (!providerConfig) {
      reject(new Error('未知的提供商'));
      return;
    }
    
    let systemPrompt = LLM_CONFIG.systemPrompt;
    
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
    
    console.log('🤖 AI优化 - 请求URL:', llmRequest.url);
    console.log('🤖 AI优化 - 提供商:', providerConfig.name);
    console.log('🤖 AI优化 - 模型:', model);
    console.log('🤖 AI优化 - 输出语言:', userLanguage);
    console.log('🤖 AI优化 - 用户内容长度:', userContent.length);
    
    // 发送请求
    $.ajax({
      url: llmRequest.url,
      type: 'POST',
      contentType: 'application/json',
      dataType: 'json',
      headers: llmRequest.headers,
      data: JSON.stringify(llmRequest.body),
      success: function(response) {
        console.log('✅ AI优化 - 响应:', response);
        
        // 提取优化后的内容
        const optimizedContent = extractLLMText(providerConfig, response);
        if (optimizedContent) {
          resolve(optimizedContent);
        } else {
          reject(new Error('响应格式错误'));
        }
      },
      error: function(xhr, status, error) {
        console.error('❌ AI优化 - API错误:', {
          status: xhr.status,
          statusText: xhr.statusText,
          response: xhr.responseText,
          error: error
        });
        
        reject(new Error(extractLLMErrorMessage(xhr)));
      }
    });
  });
}

// 页面加载完成后初始化
$(document).ready(function() {
  // 初始化LLM配置界面
  initLLMConfig();
  
  // 绑定AI优化按钮点击事件
  $('#ai_optimize').click(function(e) {
    e.preventDefault();
    optimizeWithAI();
  });
});

