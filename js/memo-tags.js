/**
 * Tag extraction for the visibility rules. Approximates the Memos 26.11 tag
 * lexer: code, link text, link destinations and bare URLs never contain tags.
 *
 * Where Markdown is ambiguous without a full parser (indented lines, where a
 * bare URL ends), the hidden tag is matched against the generous reading and
 * the public tag against the cautious one, so a doubt never widens visibility.
 */
var MemoTags = (function () {
  var character = '[\\p{XID_Continue}\\-+&\\p{RGI_Emoji}]';
  var segment = character + "+(?:(?<=\\p{XID_Continue})['\u2019](?=[\\p{L}\\p{N}_])" + character + '+)*';
  var tagPattern = new RegExp('#(' + segment + '(?:/' + segment + ')*)', 'gv');
  var scheme = '(?:(?<![a-z0-9+.\\-])[a-z][a-z0-9+.\\-]{0,31}:\\/\\/|(?<![a-z0-9.])www\\.)';

  function skipped(urlBody) {
    return new RegExp(
      [
        // Code spans and link text cannot cross a blank line.
        '(`+)(?:(?!\\n[ \\t]*\\n)[\\s\\S])*?\\1',
        '!?\\[(?:\\\\.|[^\\]\\[\\\\\\n])*\\]\\((?:<[^>\\n]*>|[^\\s)]*)(?:\\s+(?:"[^"\\n]*"|\'[^\'\\n]*\'))?\\)',
        '!?\\[[^\\]\\[\\n]*\\]\\[[^\\]\\[\\n]*\\]',
        '<[a-z][a-z0-9+.\\-]{0,31}:[^>\\s]*>',
        scheme + urlBody
      ].join('|'),
      'gi'
    );
  }
  var generous = skipped('[^\\s\\u0080-\\uFFFF<>]*');
  var cautious = skipped('\\S*');

  function literalText(content, strict) {
    var fence = null;
    return String(content || '')
      .split('\n')
      .map(function (line) {
        var marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (fence) {
          if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())
            fence = null;
          return '';
        }
        // A backtick fence's info string cannot contain a backtick.
        if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
          fence = marker[1];
          return '';
        }
        return strict && /^( {4}|\t)/.test(line) ? '' : line;
      })
      .join('\n')
      .replace(strict ? cautious : generous, ' ');
  }

  function extract(content, strict) {
    var found = new Set();
    for (var match of literalText(content, strict).matchAll(tagPattern)) {
      var parts = match[1].split('/');
      if (parts.length > 16) {
        found.add(match[1]);
        continue;
      }
      for (var i = 1; i <= parts.length; i++) found.add(parts.slice(0, i).join('/'));
    }
    return Array.from(found);
  }

  // A rule holds one or more tag names separated by spaces or commas.
  function list(value) {
    var names = String(value || '')
      .split(/[\s,，、]+/)
      .map(function (name) {
        return name.replace(/^#/, '');
      })
      .filter(Boolean);
    return Array.from(new Set(names));
  }

  function normalize(value) {
    return list(value).join(' ');
  }

  function matches(tags, names) {
    return names.some(function (name) {
      return tags.includes(name);
    });
  }

  function visibility(content, rules) {
    var hidden = list(rules.hidetag),
      shown = list(rules.showtag);
    if (hidden.length && matches(extract(content, false), hidden)) return 'PRIVATE';
    if (shown.length && matches(extract(content, true), shown)) return 'PUBLIC';
    return rules.memo_lock || 'PRIVATE';
  }

  return { extract: extract, list: list, normalize: normalize, visibility: visibility };
})();
