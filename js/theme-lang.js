function applyTheme(choice = 'auto') {
  const dark = choice === 'dark' || (choice === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#themeSelect').val(choice);
}

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get({ theme: 'auto', userLanguage: '' }, prefs => {
    applyTheme(prefs.theme);
    setUiLanguage(prefs.userLanguage).catch(() => setUiLanguage('en'));
  });
  $('#themeSelect').on('change', function () { chrome.storage.sync.set({ theme: this.value }); });
  $('#languageSelect').on('change', function () { chrome.storage.sync.set({ userLanguage: this.value }); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () =>
    chrome.storage.sync.get({ theme: 'auto' }, p => applyTheme(p.theme)));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.theme) applyTheme(changes.theme.newValue);
    if (changes.userLanguage) setUiLanguage(changes.userLanguage.newValue);
  });
});
