/** A jQuery-shaped stand-in: each selector is one remembered element, and its handlers can be fired by key. */

const inert = [
  'hide',
  'show',
  'slideDown',
  'slideToggle',
  'toggleClass',
  'addClass',
  'removeClass',
  'css',
  'focus',
  'toggle',
  'empty'
];

/** What `new Option(text, value)` gives a page. */
class Option {
  constructor(text, value) {
    this.text = text;
    this.value = value;
  }
}

/**
 * An element remembers the children it was last given as `options`: replaceChildren() starts a new list
 * and add() extends it.
 *
 * handlers.get('<selector>:<event>'), or '<selector>:<event>:<delegated selector>', is a function that runs
 * every callback registered under that key, in order, and returns the last result. Listeners added to the
 * document itself are under 'document:<event>'.
 */
function createDom() {
  const nodes = new Map();
  const elementNodes = new WeakMap();
  const callbacks = new Map();
  const handlers = new Map();
  const messages = [];
  const inputChanges = [];
  const document = {
    querySelectorAll: () => [],
    addEventListener(event, callback) {
      register('document:' + event, document, callback);
    },
    getElementById: id => node('#' + id)[0]
  };

  function register(key, target, callback) {
    if (!callbacks.has(key)) {
      const list = [];
      callbacks.set(key, list);
      handlers.set(key, (...args) => {
        let result;
        for (const fn of list) result = fn.apply(target, args);
        return result;
      });
    }
    callbacks.get(key).push(callback);
  }

  function node(selector) {
    if (selector === 'textarea[name=text]') selector = '#content';
    if (nodes.has(selector)) return nodes.get(selector);
    const element = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      focus() {},
      options: [],
      replaceChildren(...children) {
        this.options = children;
      },
      add(option) {
        this.options.push(option);
      },
      addEventListener(event, callback) {
        register(selector + ':' + event, element, callback);
      },
      setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
      },
      // As a page does it in the 'preserve' mode: the selection stays on the text it was on.
      setRangeText(text, start, end) {
        const grown = text.length - (end - start);
        const selected = [this.selectionStart, this.selectionEnd].map(at => (at > end ? at + grown : at));
        this.value = this.value.slice(0, start) + text + this.value.slice(end);
        [this.selectionStart, this.selectionEnd] = selected;
      }
    };
    const wrapper = {
      0: element,
      length: typeof selector === 'string' && selector.startsWith('.') ? 0 : 1,
      attributes: {},
      properties: {},
      val(value) {
        if (value === undefined) return element.value;
        element.value = value;
        return this;
      },
      text(value) {
        if (value === undefined) return this.textValue || '';
        this.textValue = value;
        return this;
      },
      html(value) {
        if (value === undefined) return this.htmlValue || '';
        this.htmlValue = value;
        return this;
      },
      // Markup adds to html(); an appended element is not kept.
      append(content) {
        if (typeof content === 'string') this.htmlValue = (this.htmlValue || '') + content;
        return this;
      },
      attr(key, value) {
        if (value === undefined) return this.attributes[key];
        this.attributes[key] = value;
        return this;
      },
      removeAttr(key) {
        delete this.attributes[key];
        return this;
      },
      prop(key, value) {
        if (value === undefined) return this.properties[key];
        this.properties[key] = value;
        element[key] = value;
        return this;
      },
      is(query) {
        return query === ':checked' && !!this.properties.checked;
      },
      data(key) {
        return this.attributes['data-' + key];
      },
      on(events, delegated, callback) {
        for (const event of events.split(' ')) {
          const key = selector + ':' + event + (typeof delegated === 'string' ? ':' + delegated : '');
          register(key, element, callback || delegated);
        }
        return this;
      },
      click(callback) {
        return callback ? this.on('click', callback) : this.trigger('click');
      },
      change(callback) {
        return this.on('change', callback);
      },
      blur(callback) {
        return this.on('blur', callback);
      },
      trigger(event) {
        handlers.get(selector + ':' + event)?.({ target: element, preventDefault() {} });
        if (selector === '#content' && event === 'input') inputChanges.push(element.value);
        return this;
      },
      ready(callback) {
        this.readyCallback = callback;
        return this;
      },
      each() {
        return this;
      },
      find(child) {
        return node(selector + ' ' + child);
      }
    };
    for (const method of inert) {
      wrapper[method] = function () {
        return this;
      };
    }
    nodes.set(selector, wrapper);
    elementNodes.set(element, wrapper);
    return wrapper;
  }

  function $(selector) {
    if (selector === document) return node('document');
    if (selector && typeof selector === 'object' && elementNodes.has(selector)) return elementNodes.get(selector);
    return node(selector);
  }
  $.message = value => messages.push(value.message);
  $.each = (items, callback) => items.forEach((item, index) => callback(index, item));

  return { $, document, node, handlers, messages, inputChanges, Option };
}

module.exports = { createDom };
