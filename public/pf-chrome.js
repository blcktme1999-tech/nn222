(function () {
  if (window.__pfChrome) return;
  window.__pfChrome = true;

  var logoHeader = document.body.dataset.pfHeader === 'logo';
  function frame(which, title, background) {
    var iframe = document.createElement('iframe');
    var file = which === 'header' && logoHeader ? 'pf-backend-header-frame.html' : 'pf-' + which + '-frame.html';
    iframe.src = '/public/' + file + '?v=10';
    iframe.title = title;
    iframe.setAttribute('scrolling', 'no');
    iframe.style.cssText = 'display:block;width:100%;border:0;background:' + background + ';';
    iframe.style.height = which === 'header' ? (logoHeader ? '72px' : '210px') : '640px';
    if (which === 'header') {
      iframe.style.position = 'sticky';
      iframe.style.top = '0';
      iframe.style.zIndex = '10000';
    }
    return iframe;
  }

  var header = document.querySelector('iframe[data-pf-chrome="header"]') || frame('header', 'Polícia Federal', '#fff');
  var footer = document.querySelector('iframe[data-pf-chrome="footer"]') || frame('footer', 'Rodapé da Polícia Federal', '#071d41');
  header.dataset.pfChrome = 'header';
  footer.dataset.pfChrome = 'footer';
  if (!header.parentNode) document.body.prepend(header);

  function placeFooter() {
    if (!footer.parentNode) document.body.appendChild(footer);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', placeFooter);
  else placeFooter();

  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.type !== 'pf-chrome-height') return;
    var target = data.which === 'header' ? header : footer;
    if (event.source !== target.contentWindow) return;
    var height = Number(data.height);
    if (!height) return;
    target.style.height = Math.ceil(height) + 'px';
  });
})();
