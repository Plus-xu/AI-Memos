$.extend({
  message(options) {
    if (typeof options === 'string') options = { message: options };
    $('.tip').remove();
    const tip = $('<div class="tip" role="status"></div>').text(options.message);
    $('body').append(tip);
    if (options.autoClose !== false) setTimeout(() => tip.remove(), options.time || 3000);
  }
});
