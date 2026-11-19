if (document.documentElement.dataset.view === 'panel-entry') {
  location.replace('popup.html?view=panel');
} else if (new URLSearchParams(location.search).get('view') === 'panel') {
  document.documentElement.dataset.view = 'panel';
}
