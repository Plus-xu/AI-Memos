/**
 * AI优化功能实现
 * 负责LLM配置管理和内容优化
 */

// 初始化LLM配置界面
function initLLMConfig() {
  // 加载保存的配置
  chrome.storage.sync.get(['llmProvider', 'llmModel', 'llmCustomModel', 'llmApiKey', 'llmBaseUrl'], function(data) {
    const provider = data.llmProvider || LLM_CONFIG.defaults.provider;
    if (LLM_CONFIG.providers[provider]) {
      $('#llmProvider').val(provider);
      updateModelList(provider);
    } else {
      $('#llmProvider').val(LLM_CONFIG.defaults.provider);
      updateModelList(LLM_CONFIG.defaults.provider);
    }
    updateBaseUrlVisibility($('#llmProvider').val());
    
    if (data.llmModel) {
      $('#llmModel').val(data.llmModel);
      if (data.llmModel === 'custom' && data.llmCustomModel) {
        $('#llmCustomModel').val(data.llmCustomModel).show();
      }
    }
    
    if (data.llmApiKey) {
      $('#llmApiKey').val(data.llmApiKey);
    }

    if (data.llmBaseUrl) {
      $('#llmBaseUrl').val(data.llmBaseUrl);
    }
    
    // 更新占位符文本
    updatePlaceholders();
  });
  
  // 监听提供商选择变化
  $('#llmProvider').change(function() {
    const provider = $(this).val();
    updateModelList(provider);
    updateBaseUrlVisibility(provider);
    $('#llmCustomModel').hide().val('');
  });
  
  // 监听模型选择变化
  $('#llmModel').change(function() {
    const model = $(this).val();
    if (model === 'custom') {
      $('#llmCustomModel').show();
    } else {
      $('#llmCustomModel').hide().val('');
    }
  });
}

// 更新模型列表
function updateModelList(provider) {
  const $modelSelect = $('#llmModel');
  $modelSelect.empty();
  
  if (LLM_CONFIG.providers[provider]) {
    const models = LLM_CONFIG.providers[provider].models;
    models.forEach(function(model) {
      $modelSelect.append(`<option value="${model.value}">${model.label}</option>`);
    });
  }
}

// 根据提供商切换 Base URL 输入框
function updateBaseUrlVisibility(provider) {
  const requiresBaseUrl = LLM_CONFIG.providers[provider] && LLM_CONFIG.providers[provider].requiresBaseUrl;
  $('#llmBaseUrlLabel').toggle(!!requiresBaseUrl);
  $('#llmBaseUrl').toggle(!!requiresBaseUrl);
}

// 更新占位符文本
function updatePlaceholders() {
  $('#llmCustomModel').attr('placeholder', chrome.i18n.getMessage('llmCustomModelPlaceholder'));
  $('#llmApiKey').attr('placeholder', chrome.i18n.getMessage('llmApiKeyPlaceholder'));
  $('#llmBaseUrl').attr('placeholder', chrome.i18n.getMessage('llmBaseUrlPlaceholder'));
}

// 保存LLM配置（在原有保存按钮点击时调用）
function saveLLMConfig() {
  const provider = $('#llmProvider').val();
  const model = $('#llmModel').val();
  const customModel = $('#llmCustomModel').val();
  const apiKey = $('#llmApiKey').val();
  const baseUrl = $('#llmBaseUrl').val();
  
  chrome.storage.sync.set({
    llmProvider: provider,
    llmModel: model,
    llmCustomModel: customModel,
    llmApiKey: apiKey,
    llmBaseUrl: baseUrl
  });
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

// AI优化功能
function optimizeWithAI() {
  const content = $('#content').val();
  
  // 验证内容
  if (!content || content.trim() === '') {
    $.message({
      message: chrome.i18n.getMessage('aiNoContent')
    });
    return;
  }
  
  // 获取LLM配置和用户语言设置
  chrome.storage.sync.get(['llmProvider', 'llmModel', 'llmCustomModel', 'llmApiKey', 'llmBaseUrl', 'userLanguage'], function(data) {
    if (!data.llmProvider || !data.llmModel) {
      $.message({
        message: chrome.i18n.getMessage('aiNotConfigured')
      });
      return;
    }
    
    if (!data.llmApiKey || data.llmApiKey.trim() === '') {
      $.message({
        message: chrome.i18n.getMessage('aiApiKeyRequired')
      });
      return;
    }
    
    // 确定实际使用的模型名称
    let modelName = data.llmModel;
    if (data.llmModel === 'custom' && data.llmCustomModel) {
      modelName = data.llmCustomModel;
    }
    
    // 获取用户语言设置（如果没有设置，默认使用浏览器语言）
    let userLanguage = data.userLanguage;
    if (!userLanguage) {
      const browserLang = chrome.i18n.getUILanguage();
      if (browserLang.startsWith('zh')) {
        userLanguage = 'zh_CN';
      } else if (browserLang.startsWith('ja')) {
        userLanguage = 'ja';
      } else {
        userLanguage = 'en';
      }
    }
    
    console.log('🌐 用户语言设置:', userLanguage);
    
    // 显示加载状态
    const $aiBtn = $('#ai_optimize');
    $aiBtn.prop('disabled', true).addClass('loading');
    $.message({
      message: chrome.i18n.getMessage('aiOptimizing')
    });
    
    // 调用LLM API，传入用户语言设置
    callLLMAPI(data.llmProvider, modelName, data.llmApiKey, content, userLanguage, data.llmBaseUrl)
      .then(function(optimizedContent) {
        // 优化成功
        $('#content').val(optimizedContent);
        $.message({
          message: chrome.i18n.getMessage('aiOptimizeSuccess')
        });
      })
      .catch(function(error) {
        console.error('AI优化失败:', error);
        $.message({
          message: chrome.i18n.getMessage('aiOptimizeFailed') + ': ' + error.message
        });
      })
      .finally(function() {
        // 恢复按钮状态
        $aiBtn.prop('disabled', false).removeClass('loading');
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

