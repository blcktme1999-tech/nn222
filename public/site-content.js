'use strict';

const HOME_LIMIT = 4;
const TABS = { breaking: 'tab01', clarification: 'tab02', notice: 'tab03', crime: 'tab04' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function pathKey(value) {
  return String(value || '').replace(/\/+$/, '').replace(/\.html$/, '');
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function byOrder(left, right) {
  return left.sortOrder - right.sortOrder || String(left.id).localeCompare(String(right.id));
}

function categoryOf(pathname) {
  const path = pathKey(pathname);
  if (path.endsWith('/breaking-news')) return 'breaking';
  if (path.endsWith('/clarifications')) return 'clarification';
  if (path.endsWith('/notices')) return 'notice';
  if (path.endsWith('/crime-methods')) return 'crime';
  return '';
}

function isHome(pathname) {
  const path = pathKey(pathname);
  return path === '' || path === '/' || path.endsWith('/index');
}

function phoneHref(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `tel:${digits}` : '';
}

function mapHref(contact) {
  if (contact.mapUrl) return contact.mapUrl;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(contact.address)}`;
}

function walkText(node, visitor) {
  if (node.nodeType === Node.ELEMENT_NODE && /^(SCRIPT|STYLE|TEXTAREA|NOSCRIPT)$/.test(node.tagName)) return;
  if (node.nodeType === Node.TEXT_NODE) visitor(node);
  else [...node.childNodes].forEach((child) => walkText(child, visitor));
}

function applyContact(contact) {
  walkText(document.body, (node) => {
    const text = node.textContent || '';
    if (text.length > 180) return;
    if (/地址\s*[:：]/.test(text)) node.textContent = text.replace(/地址\s*[:：][^\n]*/, `地址：${contact.address}`);
    if (/服務電話\s*[:：]/.test(text) && !/檢舉/.test(text)) {
      const label = /偵防/.test(text) ? '偵防中心服務電話' : '服務電話';
      node.textContent = text.replace(/((?:偵防中心)?服務電話)\s*[:：][^\n]*/, `${label}：${contact.servicePhone}`);
    }
  });
  document.querySelectorAll('a').forEach((link) => {
    const label = `${link.getAttribute('title') || ''} ${link.textContent || ''}`;
    if (!/Map|地圖/.test(label)) return;
    link.href = mapHref(contact);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
  document.querySelectorAll('p, li, div, td').forEach((element) => {
    const text = element.textContent || '';
    if (text.length > 400 || !/檢舉電話\s*[:：]/.test(text)) return;
    if ([...element.children].some((child) => /檢舉電話\s*[:：]/.test(child.textContent || ''))) return;
    const links = [...element.querySelectorAll('a[href^="tel:"]')].filter((link) => link.getAttribute('href') !== 'tel:110');
    (contact.reportPhones || []).forEach((phone, index) => {
      const link = links[index];
      if (!link) return;
      link.textContent = phone;
      link.href = phoneHref(phone);
    });
  });
}

function applyUnitEmail(units) {
  const unit = units.find((item) => samePath(location.pathname, item.path));
  let slot = document.querySelector('[data-site-unit-email]');
  if (!unit?.email) {
    slot?.remove();
    return;
  }
  if (!slot) {
    slot = document.createElement('p');
    slot.dataset.siteUnitEmail = '1';
    slot.style.cssText = 'margin:16px;padding:12px 16px;background:#f4f7fb;border-left:4px solid #0b4f8a;color:#16325c;font-size:16px;line-height:1.6;';
    const footer = document.querySelector('footer');
    if (footer?.parentNode) footer.parentNode.insertBefore(slot, footer);
    else document.body.appendChild(slot);
  }
  slot.innerHTML = `電子信箱：<a href="mailto:${escapeHtml(unit.email)}">${escapeHtml(unit.email)}</a>`;
}

function homeItem(item) {
  const href = escapeHtml(item.path);
  const title = escapeHtml(item.title);
  return `<li><a href="${href}" title="${title}"><p class="color01">${escapeHtml(item.publishedOn)}</p><p class="color02">${escapeHtml(item.publisher)}</p><p class="item">${title}</p></a></li>`;
}

function listItem(item, index) {
  const href = escapeHtml(item.path);
  const title = escapeHtml(item.title);
  if (document.querySelector('ul.news-index')) {
    return `<li><a href="${href}"><span>${escapeHtml(item.publishedOn)}</span>${title}</a></li>`;
  }
  return `<li><a href="${href}" title="${title}"><div class="info"><p class="color02">發布日期：${escapeHtml(item.publishedOn)}</p><p class="color01">發布單位：${escapeHtml(item.publisher)}</p></div><p class="subject">${index + 1}.${title}</p></a></li>`;
}

const POSTER_ALTS = {
  '/public/home-posters/stalking.jpg': '防制跟蹤騷擾，保障婦幼安全',
  '/public/home-posters/drunk-driving.jpg': '生命無價，拒絕酒駕',
  '/public/home-posters/shelter.jpg': '避難指引演練熟，危險來臨不用愁'
};

function applyPosters(posters) {
  if (!isHome(location.pathname)) return;
  const root = document.querySelector('.home-poster');
  if (!root || !Array.isArray(posters) || !posters.length) return;
  const urls = posters.map((item) => String(item.url || '').trim()).filter(Boolean);
  if (!urls.length) return;
  root.querySelectorAll('img, .home-poster-dots').forEach((node) => node.remove());
  const dots = document.createElement('div');
  dots.className = 'home-poster-dots';
  urls.forEach((url, index) => {
    const img = document.createElement('img');
    img.src = url;
    img.alt = POSTER_ALTS[url] || '';
    if (index === 0) img.className = 'is-active';
    root.appendChild(img);
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', POSTER_ALTS[url] || `第${index + 1}張`);
    button.textContent = String(index + 1);
    if (index === 0) button.className = 'is-active';
    dots.appendChild(button);
  });
  root.appendChild(dots);
  if (typeof window.startHomePoster === 'function') window.startHomePoster();
}

function applyNews(news) {
  if (!Array.isArray(news) || !news.length) return;
  if (isHome(location.pathname)) {
    Object.entries(TABS).forEach(([category, tab]) => {
      const list = document.querySelector(`#${tab} .news ul`);
      if (!list) return;
      const visible = news.filter((item) => item.category === category).sort(byOrder).slice(0, HOME_LIMIT);
      list.innerHTML = visible.map(homeItem).join('');
    });
    return;
  }
  const category = categoryOf(location.pathname);
  if (!category) return;
  const list = document.querySelector('ul.news-index') || document.querySelector('a[id^="listImageNum"]')?.closest('ul');
  if (!list) return;
  const visible = news.filter((item) => item.category === category).sort(byOrder);
  list.innerHTML = visible.map(listItem).join('');
}

function articleBody(item) {
  const text = escapeHtml(item.body).split('\n').map((line) => `<p>${line || '&nbsp;'}</p>`).join('');
  const images = (item.images || []).map((url) => `<p><img src="${escapeHtml(url)}" alt=""></p>`).join('');
  return text + images;
}

function applyArticle(news) {
  const view = document.querySelector('[data-article-view]');
  if (view) {
    const id = new URLSearchParams(location.search).get('id');
    const item = news.find((entry) => entry.id === id);
    if (!item) {
      view.innerHTML = '<p>找不到這則新聞。</p>';
      return;
    }
    document.title = item.title;
    view.innerHTML = `<p class="meta">${escapeHtml(item.publishedOn)}　${escapeHtml(item.publisher)}</p><h1>${escapeHtml(item.title)}</h1><div class="body">${articleBody(item)}</div>`;
    return;
  }
  const item = news.find((entry) => entry.legacyPath && samePath(location.pathname, entry.legacyPath));
  if (!item) return;
  const title = document.querySelector('.d_title');
  if (title) title.textContent = item.title;
  document.querySelectorAll('p').forEach((element) => {
    const text = element.textContent || '';
    if (text.length > 120) return;
    if (text.includes('發布日期')) element.textContent = `發布日期：${item.publishedOn}`;
    if (text.includes('更新日期')) element.textContent = `更新日期：${item.updatedOn || item.publishedOn}`;
    if (text.includes('發布單位')) element.textContent = `發布單位：${item.publisher}`;
  });
  if (!item.customized) return;
  const body = document.querySelector('.editor') || document.querySelector('.d_sub');
  if (body) body.innerHTML = articleBody(item);
}

function bindCategoryTabs() {
  if (document.getElementById('category-tab-layout')) return;
  const style = document.createElement('style');
  style.id = 'category-tab-layout';
  style.textContent = [
    '.nav-tabs>li>a,.nav-tabs .nav-link,.tabs>ul>li>a{background:#dedede!important;color:#000!important;border:0!important;border-radius:0!important;text-align:center}',
    '.nav-tabs>li>a.active,.nav-tabs .nav-link.active,.nav-tabs>li.active>a,.tabs>ul>li>a.active,.tabs>ul>li.active>a{background:#3153ba!important;color:#fff!important}'
  ].join('');
  document.head.appendChild(style);
}

function bindWantedTabs() {
  const list = document.getElementById('myTab02');
  if (!list || list.dataset.wantedTabs) return;
  list.dataset.wantedTabs = '1';
  const style = document.createElement('style');
  style.id = 'wanted-tab-layout';
  style.textContent = [
    '#myTab02{display:flex!important;flex-wrap:nowrap!important;width:100%;margin:0;padding:0}',
    '#myTab02>.nav-item{box-sizing:border-box;margin:0!important;float:none!important;min-width:0!important;display:flex!important;flex:1 1 0%!important;max-width:none!important;width:auto!important}',
    '#myTab02 .nav-link{display:flex!important;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;padding:14px 8px;font-size:110%;line-height:1.35;white-space:nowrap!important;text-align:center;text-decoration:none}',
    '#myTab02.wanted-tabs-wrapped{flex-wrap:wrap!important}',
    '#myTab02.wanted-tabs-wrapped>.nav-item:nth-child(-n+3){flex:0 0 33.333%!important;max-width:33.333%!important;width:33.333%!important}',
    '#myTab02.wanted-tabs-wrapped>.nav-item:nth-child(4){flex:0 0 100%!important;max-width:100%!important;width:100%!important}'
  ].join('');
  document.head.appendChild(style);
  const items = [...list.children];
  const longLink = items[3]?.querySelector('a');
  function neededWidth() {
    const probe = longLink.cloneNode(true);
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;width:auto;height:auto;display:block';
    document.body.appendChild(probe);
    const width = probe.scrollWidth;
    probe.remove();
    return width;
  }
  function fit() {
    if (!longLink || items.length !== 4 || !list.clientWidth) return;
    list.classList.toggle('wanted-tabs-wrapped', neededWidth() > list.clientWidth / 4 + 8);
  }
  window.addEventListener('resize', fit);
  fit();
}

function bindFooterLogos() {
  if (!document.getElementById('footer-logo-scroll')) {
    const style = document.createElement('style');
    style.id = 'footer-logo-scroll';
    style.textContent = '.sbanner .slick-list{overflow:hidden;touch-action:pan-y;height:auto!important}.sbanner .slick-slide{height:auto!important}.sbanner .slick-prev,.sbanner .slick-next{z-index:2;cursor:pointer}';
    document.head.appendChild(style);
  }
  document.querySelectorAll('.sbanner').forEach((root) => {
    if (root.dataset.logoBound) return;
    const track = root.querySelector('.slick-track');
    const list = root.querySelector('.slick-list');
    if (!track || !list) return;
    root.dataset.logoBound = '1';
    track.querySelectorAll('.slick-cloned').forEach((node) => node.remove());
    const slides = [...track.children];
    if (!slides.length) return;
    let index = 0;
    let startX = 0;
    function perView() {
      return Math.min(slides.length, Math.max(1, Math.floor(list.clientWidth / 250)));
    }
    function show() {
      const view = perView();
      const max = Math.max(0, slides.length - view);
      if (index > max) index = 0;
      if (index < 0) index = max;
      const width = list.clientWidth / view;
      slides.forEach((slide) => { slide.style.width = `${width}px`; });
      track.style.width = `${width * slides.length}px`;
      track.style.transition = 'transform .35s ease';
      track.style.transform = `translate3d(${-index * width}px,0,0)`;
    }
    root.querySelector('.slick-prev')?.addEventListener('click', (event) => {
      event.preventDefault();
      index -= 1;
      show();
    });
    root.querySelector('.slick-next')?.addEventListener('click', (event) => {
      event.preventDefault();
      index += 1;
      show();
    });
    list.addEventListener('pointerdown', (event) => { startX = event.clientX; });
    list.addEventListener('pointerup', (event) => {
      const delta = event.clientX - startX;
      if (Math.abs(delta) < 40) return;
      index += delta < 0 ? 1 : -1;
      show();
    });
    window.addEventListener('resize', show);
    show();
  });
}

function blankImage(img) {
  const src = img?.getAttribute('src') || '';
  return !src || src === 'data:,' || src.startsWith('data:image/svg');
}

function bindFooterBrand(qrUrl) {
  document.getElementById('site-footer-brand')?.remove();
  const footer = document.querySelector('footer');
  if (!footer) return;
  if (!document.getElementById('site-footer-layout')) {
    const style = document.createElement('style');
    style.id = 'site-footer-layout';
    style.textContent = [
      'footer .container,footer .editor,footer .info{position:relative}',
      'footer .logo img{width:min(280px,72vw);height:auto;display:block}',
      'footer .right ul:first-child img{width:120px;height:120px;object-fit:contain;background:#fff}',
      'footer .right ul:last-child img{height:46px;width:auto}',
      '@media (max-width:991px){footer .right{position:static!important}footer .right ul,footer .right ul li{float:none!important;text-align:left}}'
    ].join('');
    document.head.appendChild(style);
  }
  const headerLogo = document.querySelector('header h1.logo img, header .logo img');
  const footerLogo = footer.querySelector('.logo img');
  if (footerLogo && blankImage(footerLogo)) {
    const headerSrc = headerLogo?.getAttribute('src') || '';
    footerLogo.src = headerSrc && headerSrc !== 'data:,' ? headerSrc : '/public/images/cib-footer.png';
  }
  const qrImage = footer.querySelector('.right img');
  if (qrImage) qrImage.src = qrUrl || '/public/home-sections/footer-qr.png';
  const badges = footer.querySelectorAll('.right ul + ul img');
  const badgeSrc = ['/public/home-sections/footer-gov.png', '/public/home-sections/footer-access.png'];
  badges.forEach((img, index) => {
    const src = img.getAttribute('src') || '';
    if ((blankImage(img) || src.includes('at01-min') || src.includes('at02_1-min')) && badgeSrc[index]) img.src = badgeSrc[index];
  });
}

function bindHeaderSearch() {
  document.querySelectorAll('form.gsc-search-box, .search_box form').forEach((form) => {
    if (form.dataset.googleSearchBound) return;
    form.dataset.googleSearchBound = '1';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = form.querySelector('input.gsc-input, input[name="search"]');
      const query = String(input?.value || '').trim();
      if (!query) return;
      window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank', 'noopener,noreferrer');
    });
  });
}

async function applySiteContent() {
  let payload;
  try {
    const response = await fetch('/api/site-content', { credentials: 'same-origin', cache: 'no-store' });
    if (response.ok) payload = await response.json();
  } catch (_error) {
    payload = null;
  }
  bindFooterBrand(payload && payload.footerQr);
  if (payload && typeof payload === 'object') {
    if (payload.contact) applyContact(payload.contact);
    if (Array.isArray(payload.units)) applyUnitEmail(payload.units);
    if (Array.isArray(payload.posters)) applyPosters(payload.posters);
    if (Array.isArray(payload.news)) {
      applyNews(payload.news);
      applyArticle(payload.news);
    }
  }
  document.documentElement.classList.add('site-footer-ready');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { bindHeaderSearch(); bindFooterLogos(); bindFooterBrand(); bindCategoryTabs(); bindWantedTabs(); applySiteContent(); });
else { bindHeaderSearch(); bindFooterLogos(); bindCategoryTabs(); bindWantedTabs(); bindFooterBrand(); applySiteContent(); }
