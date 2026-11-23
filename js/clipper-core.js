/** Formatting only: never runs page code, requests an AI provider, or saves to Memos. */
var ClipperCore = (function () {
  var defaultTemplate = '> {{content}}\n\n[{{title}}]({{url}})\n\n{{date}}';

  function safeUrl(value) {
    var url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('invalid_capture_url');
    return url.href.replace(/[()]/g, function (character) {
      return character === '(' ? '%28' : '%29';
    });
  }

  function validateTemplate(template) {
    if (
      typeof template !== 'string' ||
      template.length > 8000 ||
      !/{{\s*content\s*}}/.test(template) ||
      !/{{\s*url\s*}}/.test(template)
    ) {
      throw new Error('invalid_clip_template');
    }
    return template;
  }

  function format(capture, template) {
    template = validateTemplate(template === undefined ? defaultTemplate : template);
    var content = String(capture.content || '')
      .replace(/\r\n/g, '\n')
      .trim();
    if (!content) throw new Error('empty_selection');
    var values = {
      content: content,
      title: String(capture.title || capture.url)
        .replace(/[\\\[\]]/g, '\\$&')
        .replace(/[\r\n]+/g, ' '),
      url: safeUrl(capture.url),
      date: new Date(capture.capturedAt || Date.now()).toISOString()
    };
    // One pass keeps placeholder-like text in the selection literal.
    return template
      .replace(
        /(^[ \t]*(?:> ?)+){{\s*content\s*}}[ \t]*(?=\r?$)|{{\s*(title|url|content|date)\s*}}/gm,
        function (_, quote, key) {
          return quote
            ? content
                .split('\n')
                .map(function (line) {
                  return quote + line;
                })
                .join('\n')
            : values[key];
        }
      )
      .trim();
  }

  function append(current, clip) {
    return (current ? current.replace(/\s+$/, '') + '\n\n' : '') + clip + '\n';
  }

  return {
    defaultTemplate: defaultTemplate,
    safeUrl: safeUrl,
    validateTemplate: validateTemplate,
    format: format,
    append: append
  };
})();
