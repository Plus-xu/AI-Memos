/**
 * Tag extraction for the visibility rules. Approximates the Memos 26.11 tag
 * lexer: code, link text, link destinations and bare URLs never contain tags.
 */
var MemoTags = (function () {
  var character = '[\\p{XID_Continue}\\-+&\\p{RGI_Emoji}]';
  var segment = character + '+(?:(?<=\\p{XID_Continue})[\'\u2019](?=[\\p{L}\\p{N}_])' + character + '+)*';
  var tagPattern = new RegExp('#(' + segment + '(?:/' + segment + ')*)', 'gv');
  var skipped = new RegExp([
    '(`+)[\\s\\S]*?\\1',
    '!?\\[(?:\\\\.|[^\\]\\\\])*\\]\\((?:<[^>\\n]*>|[^\\s)]*)(?:\\s+(?:"[^"]*"|\'[^\']*\'))?\\)',
    '!?\\[[^\\]\\n]*\\]\\[[^\\]\\n]*\\]',
    '<[a-z][a-z0-9+.\\-]*:[^>\\s]*>',
    '(?:[a-z][a-z0-9+.\\-]*:\\/\\/|www\\.)\\S+'
  ].join('|'), 'gi');

  function literalText(content) {
    var fence = null;
    return String(content || '').split('\n').map(function (line) {
      var marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        return '';
      }
      if (marker) { fence = marker[1]; return ''; }
      return /^( {4}|\t)/.test(line) ? '' : line;
    }).join('\n').replace(skipped, ' ');
  }

  function extract(content) {
    var found = new Set();
    for (var match of literalText(content).matchAll(tagPattern)) {
      var parts = match[1].split('/');
      for (var i = 1; i <= parts.length; i++) found.add(parts.slice(0, i).join('/'));
    }
    return Array.from(found);
  }

  function normalize(value) {
    return String(value || '').trim().replace(/^#/, '').trim();
  }

  function visibility(content, rules) {
    var tags = new Set(extract(content));
    var hidden = normalize(rules.hidetag), shown = normalize(rules.showtag);
    if (hidden && tags.has(hidden)) return 'PRIVATE';
    if (shown && tags.has(shown)) return 'PUBLIC';
    return rules.memo_lock || 'PRIVATE';
  }

  return { extract: extract, normalize: normalize, visibility: visibility };
})();
