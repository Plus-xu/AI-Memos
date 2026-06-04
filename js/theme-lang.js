/**
 * 主题和语言切换管理器
 * Theme and Language Manager
 */

// 主题模式常量
const THEME_AUTO = 'auto';
const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';

// 获取系统主题偏好
function getSystemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? THEME_DARK
    : THEME_LIGHT;
}

// 应用主题
function applyTheme(theme) {
  const body = document.body;

  // 移除所有主题类
  body.classList.remove('theme-light', 'theme-dark');

  // 确定实际应用的主题
  const actualTheme = theme === THEME_AUTO ? getSystemTheme() : theme;

  // 应用主题类
  body.classList.add(`theme-${actualTheme}`);

  // 更新主题按钮的图标和提示文本
  updateThemeButton(theme);
}

// 更新主题按钮（图标和标题）
function updateThemeButton(theme) {
  const themeToggle = document.getElementById('theme_toggle');
  if (!themeToggle) return;

  // 更新 data-theme 属性以切换图标显示
  themeToggle.setAttribute('data-theme', theme);

  // 更新按钮的 title 提示文本
  let titleKey = 'themeAuto';
  if (theme === THEME_LIGHT) titleKey = 'themeLight';
  if (theme === THEME_DARK) titleKey = 'themeDark';

  themeToggle.title = chrome.i18n.getMessage(titleKey);
}

// 更新主题按钮标题（保留向后兼容）
function updateThemeButtonTitle(theme) {
  updateThemeButton(theme);
}

// 获取下一个主题
function getNextTheme(currentTheme) {
  const themes = [THEME_AUTO, THEME_LIGHT, THEME_DARK];
  const currentIndex = themes.indexOf(currentTheme);
  return themes[(currentIndex + 1) % themes.length];
}

// 初始化主题
function initTheme() {
  chrome.storage.sync.get({theme: THEME_AUTO}, function(items) {
    applyTheme(items.theme);
  });

  // 初始化设置按钮的 title
  const settingsBtn = document.getElementById('blog_info_edit');
  if (settingsBtn) {
    settingsBtn.title = chrome.i18n.getMessage('settingsBtn');
  }

  // 监听系统主题变化
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
      chrome.storage.sync.get({theme: THEME_AUTO}, function(items) {
        if (items.theme === THEME_AUTO) {
          applyTheme(THEME_AUTO);
        }
      });
    });
  }
}

// 主题切换按钮点击事件
document.getElementById('theme_toggle').addEventListener('click', function() {
  chrome.storage.sync.get({theme: THEME_AUTO}, function(items) {
    const nextTheme = getNextTheme(items.theme);
    chrome.storage.sync.set({theme: nextTheme}, function() {
      applyTheme(nextTheme);
      $.message({
        message: chrome.i18n.getMessage(`theme${nextTheme.charAt(0).toUpperCase() + nextTheme.slice(1)}`)
      });
    });
  });
});

// 获取当前语言
function getCurrentLanguage() {
  // 优先使用用户设置的语言
  return new Promise((resolve) => {
    chrome.storage.sync.get({userLanguage: null}, function(items) {
      if (items.userLanguage) {
        resolve(items.userLanguage);
      } else {
        // 使用浏览器语言
        const browserLang = chrome.i18n.getUILanguage();
        let lang = 'en';

        if (browserLang.startsWith('zh')) {
          lang = 'zh_CN';
        } else if (browserLang.startsWith('ja')) {
          lang = 'ja';
        }

        resolve(lang);
      }
    });
  });
}

// 应用语言（直接加载翻译文件并更新页面）
async function applyLanguage(lang) {
  // 保存语言设置
  chrome.storage.sync.set({userLanguage: lang});

  // 加载对应语言的翻译文件
  const messagesUrl = chrome.runtime.getURL(`_locales/${lang}/messages.json`);

  try {
    const response = await fetch(messagesUrl);
    const messages = await response.json();

    // 更新所有需要翻译的元素
    updatePageTexts(messages);

    // 显示成功提示
    $.message({
      message: messages.languageChanged?.message || 'Language changed successfully'
    });
  } catch (error) {
    console.error('Failed to load language file:', error);
    // 如果加载失败，使用 reload 方法
    chrome.runtime.reload();
  }
}

// 更新页面所有文本
function updatePageTexts(messages) {
  // 更新所有使用 i18n 的元素
  const updates = {
    'saveKey': 'saveBtn',
    'saveTag': 'saveBtn',
    'lockPrivate': 'lockPrivate',
    'lockProtected': 'lockProtected',
    'lockPublic': 'lockPublic',
    'content_submit_text': 'submitBtn',
    'languageLabel': 'languageLabel'
  };

  // 更新文本内容
  for (const [elementId, messageKey] of Object.entries(updates)) {
    const element = document.getElementById(elementId);
    if (element && messages[messageKey]) {
      element.textContent = messages[messageKey].message;
    }
  }

  // 更新 placeholder
  const placeholders = {
    'apiUrl': 'placeApiUrl',
    'apiTokens': 'placeApiTokens',
    'content': 'placeContent',
    'hideInput': 'placeHideInput',
    'showInput': 'placeShowInput',
    'llmCustomModel': 'llmCustomModelPlaceholder',
    'llmApiKey': 'llmApiKeyPlaceholder',
    'llmBaseUrl': 'llmBaseUrlPlaceholder'
  };

  for (const [elementId, messageKey] of Object.entries(placeholders)) {
    const element = document.getElementById(elementId);
    if (element && messages[messageKey]) {
      element.placeholder = messages[messageKey].message;
    }
  }
  
  // 更新 AI 配置标签
  const aiLabels = {
    'llmProviderLabel': 'llmProviderLabel',
    'llmModelLabel': 'llmModelLabel',
    'llmApiKeyLabel': 'llmApiKeyLabel',
    'llmBaseUrlLabel': 'llmBaseUrlLabel',
    'llmQuickPresetsLabel': 'llmQuickPresetsLabel'
  };
  
  for (const [elementId, messageKey] of Object.entries(aiLabels)) {
    const element = document.getElementById(elementId);
    if (element && messages[messageKey]) {
      element.textContent = messages[messageKey].message;
    }
  }

  // 更新主题按钮图标和标题
  chrome.storage.sync.get({theme: THEME_AUTO}, function(items) {
    const themeToggle = document.getElementById('theme_toggle');
    if (themeToggle) {
      // 更新图标显示
      themeToggle.setAttribute('data-theme', items.theme);
      
      // 更新标题文本
      let titleKey = 'themeAuto';
      if (items.theme === THEME_LIGHT) titleKey = 'themeLight';
      if (items.theme === THEME_DARK) titleKey = 'themeDark';

      if (messages[titleKey]) {
        themeToggle.title = messages[titleKey].message;
      }
    }
  });

  // 更新设置按钮标题
  const settingsBtn = document.getElementById('blog_info_edit');
  if (settingsBtn && messages['settingsBtn']) {
    settingsBtn.title = messages['settingsBtn'].message;
  }

  // 更新工具栏图标tooltips
  const toolbarTooltips = {
    'tags': 'tagsTooltip',
    'newtodo': 'todoTooltip',
    'upres': 'uploadTooltip',
    'getlink': 'linkTooltip',
    'random': 'randomTooltip',
    'search': 'searchTooltip',
    'lock': 'visibilityTooltip'
  };

  for (const [elementId, messageKey] of Object.entries(toolbarTooltips)) {
    const element = document.getElementById(elementId);
    if (element && messages[messageKey]) {
      element.title = messages[messageKey].message;
    }
  }

  if (typeof refreshLLMTexts === 'function') {
    refreshLLMTexts(messages);
  }
}

// 初始化语言选择器
async function initLanguageSelector() {
  const languageSelect = document.getElementById('languageSelect');
  const languageLabel = document.getElementById('languageLabel');

  if (!languageSelect || !languageLabel) return;

  // 获取当前语言
  const currentLang = await getCurrentLanguage();
  languageSelect.value = currentLang;

  // 检查是否需要应用保存的语言（与浏览器默认语言不同）
  chrome.storage.sync.get({userLanguage: null}, async function(items) {
    if (items.userLanguage && items.userLanguage !== chrome.i18n.getUILanguage().replace('-', '_')) {
      // 加载并应用保存的语言
      const messagesUrl = chrome.runtime.getURL(`_locales/${items.userLanguage}/messages.json`);
      try {
        const response = await fetch(messagesUrl);
        const messages = await response.json();
        updatePageTexts(messages);
      } catch (error) {
        console.error('Failed to load saved language:', error);
      }
    }
  });

  // 设置标签文本（使用当前显示的语言）
  languageLabel.textContent = chrome.i18n.getMessage('languageLabel');

  // 监听语言变化
  languageSelect.addEventListener('change', function() {
    const selectedLang = this.value;
    const confirmMessage = chrome.i18n.getMessage('languageChangeConfirm') || 'Change language?';
    if (confirm(confirmMessage)) {
      applyLanguage(selectedLang);
    } else {
      // 恢复原来的选择
      this.value = currentLang;
    }
  });
}

// 初始化工具栏图标的 tooltips
function initToolbarTooltips() {
  const tooltipMappings = {
    'tags': 'tagsTooltip',
    'newtodo': 'todoTooltip',
    'upres': 'uploadTooltip',
    'getlink': 'linkTooltip',
    'random': 'randomTooltip',
    'search': 'searchTooltip',
    'lock': 'visibilityTooltip',
    'ai_optimize': 'aiOptimizeTooltip',
    'ai_quick_toggle': 'llmQuickPresetMenuTooltip'
  };

  for (const [elementId, messageKey] of Object.entries(tooltipMappings)) {
    const element = document.getElementById(elementId);
    if (element) {
      element.title = chrome.i18n.getMessage(messageKey);
    }
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', function() {
  initTheme();
  initLanguageSelector();
  initToolbarTooltips();
});
