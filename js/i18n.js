let uiMessages = {};
let uiLanguage = '';
function uiMessage(key) {
  return uiMessages[key]?.message || chrome.i18n.getMessage(key) || key;
}
async function setUiLanguage(language) {
  const raw = language || chrome.i18n.getUILanguage();
  const lang = raw.startsWith('zh') ? 'zh_CN' : raw.startsWith('ja') ? 'ja' : 'en';
  uiLanguage = lang;
  const response = await fetch(chrome.runtime.getURL('_locales/' + lang + '/messages.json'));
  const messages = await response.json();
  if (uiLanguage !== lang) return;
  uiMessages = messages;
  document.documentElement.lang = lang.replace('_', '-');
  const attrs = {
    'data-feature-message': 'textContent',
    'data-placeholder': 'placeholder',
    'data-title': 'title',
    'data-label': 'aria-label'
  };
  for (const [attr, target] of Object.entries(attrs)) {
    document.querySelectorAll('[' + attr + ']').forEach(node => {
      const value = uiMessage(node.getAttribute(attr));
      if (target === 'textContent') node.textContent = value;
      else node.setAttribute(target, value);
      if (target === 'title') node.setAttribute('aria-label', value);
    });
  }
  $('#languageSelect').val(lang);
  if (typeof refreshLLMTexts === 'function') refreshLLMTexts(messages);
  if (typeof Workspace !== 'undefined') Workspace.translate();
}
