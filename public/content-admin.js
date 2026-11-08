'use strict';

const state = { content: null, editing: null, images: [], posters: [], replacingPoster: null };
const MAX_POSTERS = 30;
const $ = (selector, root = document) => root.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '操作失敗');
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function rocToday() {
  const date = new Date();
  return `${date.getFullYear() - 1911}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function show(selector) { $(selector)?.classList.remove('hidden'); }
function hide(selector) { $(selector)?.classList.add('hidden'); }

function status(text, isError) {
  const node = $('#status');
  node.textContent = text || '';
  node.className = isError ? 'status error' : 'status';
}

function render() {
  const content = state.content;
  if (!content) return;
  $('#address').value = content.contact.address || '';
  $('#mapUrl').value = content.contact.mapUrl || '';
  $('#servicePhone').value = content.contact.servicePhone || '';
  $('#reportPhonePrimary').value = content.contact.reportPhones?.[0] || '';
  $('#reportPhoneSecondary').value = content.contact.reportPhones?.[1] || '';
  const emails = $('#unitEmails');
  emails.innerHTML = content.units.map((unit) => `<label>${escapeHtml(unit.name)}<input data-unit="${escapeHtml(unit.key)}" type="email" value="${escapeHtml(unit.email)}" placeholder="name@example.com" autocomplete="off"></label>`).join('');
  const qrPreview = $('#footerQrPreview');
  if (qrPreview) qrPreview.src = content.footerQr || '/public/home-sections/footer-qr.png';
  const news = $('#newsBoard');
  news.innerHTML = content.categories ? '' : '';
  const categories = [
    ['breaking', '破案快訊'],
    ['clarification', '即時新聞澄清'],
    ['notice', '公告事項'],
    ['crime', '最新犯罪手法']
  ];
  news.innerHTML = categories.map(([key, label]) => {
    const items = content.news.filter((item) => item.category === key).sort((a, b) => a.sortOrder - b.sortOrder);
    const rows = items.map((item, index) => `<li><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.publishedOn)}　${index < 4 ? '首頁' : '列表後面'}</span></div><div class="row-actions"><button type="button" data-move="up" data-id="${escapeHtml(item.id)}">上移</button><button type="button" data-move="down" data-id="${escapeHtml(item.id)}">下移</button><button type="button" data-edit="${escapeHtml(item.id)}">編輯</button><button type="button" data-delete="${escapeHtml(item.id)}">刪除</button></div></li>`).join('');
    return `<section class="news-column"><header><h2>${label}</h2><button type="button" data-add="${key}">新增</button></header><ol>${rows || '<li class="empty">這個分類還沒有新聞</li>'}</ol></section>`;
  }).join('');
  renderPosters();
}

function renderPosters() {
  const list = $('#posterList');
  if (!list) return;
  const last = state.posters.length <= 1;
  list.innerHTML = state.posters.map((item, index) => `<li><img src="${escapeHtml(item.url)}" alt=""><div class="row-actions"><button type="button" data-poster-move="up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>上移</button><button type="button" data-poster-move="down" data-index="${index}" ${index === state.posters.length - 1 ? 'disabled' : ''}>下移</button><button type="button" data-poster-replace="${index}">換圖</button><button type="button" data-poster-delete="${index}" ${last ? 'disabled' : ''}>刪除</button></div></li>`).join('') || '<li class="empty">至少要留一張橫幅</li>';
}

function rememberPosters(content) {
  state.posters = (content.posters || []).map((item) => ({ id: item.id, url: item.url }));
}

function openEditor(item) {
  state.editing = item;
  state.images = [...(item.images || [])];
  $('#editorTitle').textContent = item.id ? '編輯新聞' : '新增新聞';
  $('#newsCategory').value = item.category;
  $('#newsTitle').value = item.title || '';
  $('#newsPublished').value = item.publishedOn || rocToday();
  $('#newsUpdated').value = item.updatedOn || item.publishedOn || rocToday();
  $('#newsPublisher').value = item.publisher || '刑事警察局公共關係室';
  $('#newsBody').value = item.body || '';
  renderImages();
  $('#editor').showModal();
  $('#newsTitle').focus();
}

function renderImages() {
  $('#newsImages').innerHTML = state.images.map((url, index) => `<figure><img src="${escapeHtml(url)}" alt=""><button type="button" data-remove-image="${index}">移除</button></figure>`).join('') || '<p class="muted">尚未上傳照片</p>';
}

async function loadContent() {
  state.content = await api('/api/site-content');
  rememberPosters(state.content);
  render();
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('無法讀取圖片'));
    reader.readAsDataURL(file);
  });
}

async function uploadPoster(file) {
  const dataUrl = await readImageFile(file);
  const result = await api('/api/site-posters', { method: 'POST', body: JSON.stringify({ action: 'image', dataUrl }) });
  return result.url;
}

async function saveContact(event) {
  event.preventDefault();
  status('儲存中…');
  try {
    state.content = await api('/api/site-content', { method: 'PUT', body: JSON.stringify({
      contact: {
        address: $('#address').value,
        mapUrl: $('#mapUrl').value,
        servicePhone: $('#servicePhone').value,
        reportPhones: [$('#reportPhonePrimary').value, $('#reportPhoneSecondary').value]
      },
      units: [...$('#unitEmails').querySelectorAll('[data-unit]')].map((input) => ({ key: input.dataset.unit, email: input.value }))
    }) });
    render();
    status('聯絡資料已更新');
  } catch (error) {
    status(error.message, true);
  }
}

async function newsAction(body) {
  status('處理中…');
  state.content = await api('/api/site-news', { method: 'POST', body: JSON.stringify(body) });
  render();
  status('新聞已更新');
}

async function uploadImages(files) {
  for (const file of files) {
    const dataUrl = await readImageFile(file);
    const result = await api('/api/site-news', { method: 'POST', body: JSON.stringify({ action: 'image', dataUrl }) });
    state.images.push(result.url);
  }
  renderImages();
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  status('');
  try {
    await api('/api/staff/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
    const me = await api('/api/me');
    if (me.user?.role !== 'admin') throw new Error('這個內容後台需要管理員帳號');
    hide('#loginPanel');
    show('#workspace');
    $('#logoutButton').classList.remove('hidden');
    $('#who').textContent = me.user.displayName || me.user.username;
    await loadContent();
  } catch (error) {
    status(error.message, true);
  }
});

$('#logoutButton').addEventListener('click', async () => {
  await api('/api/staff/logout', { method: 'POST', body: '{}' }).catch(() => {});
  location.reload();
});

$('#contactForm').addEventListener('submit', saveContact);
const footerQrForm = $('#footerQrForm');
if (footerQrForm) footerQrForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('#footerQrFile').files[0];
  if (!file) return status('請先選擇二維碼圖片', true);
  status('儲存中…');
  try {
    const dataUrl = await readImageFile(file);
    const uploaded = await api('/api/site-footer', { method: 'POST', body: JSON.stringify({ action: 'image', dataUrl }) });
    const saved = await api('/api/site-footer', { method: 'POST', body: JSON.stringify({ action: 'save', url: uploaded.url }) });
    state.content.footerQr = saved.footerQr;
    $('#footerQrFile').value = '';
    render();
    status('頁尾二維碼已更新');
  } catch (error) {
    status(error.message, true);
  }
});
$('#posterForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.posters.length) return status('至少要留一張橫幅', true);
  status('儲存中…');
  try {
    state.content = await api('/api/site-posters', { method: 'POST', body: JSON.stringify({ action: 'save', posters: state.posters.map((item) => item.url) }) });
    rememberPosters(state.content);
    render();
    status('主頁橫幅已更新');
  } catch (error) {
    status(error.message, true);
  }
});
$('#posterList').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  const index = Number(button.dataset.index ?? button.dataset.posterReplace ?? button.dataset.posterDelete);
  if (button.dataset.posterMove) {
    const target = index + (button.dataset.posterMove === 'up' ? -1 : 1);
    if (target < 0 || target >= state.posters.length) return;
    const [item] = state.posters.splice(index, 1);
    state.posters.splice(target, 0, item);
    renderPosters();
    status('橫幅已調整，按儲存後才會更新主頁');
    return;
  }
  if (button.dataset.posterDelete != null) {
    if (state.posters.length <= 1) return;
    state.posters.splice(index, 1);
    renderPosters();
    status('橫幅已調整，按儲存後才會更新主頁');
    return;
  }
  if (button.dataset.posterReplace != null) {
    state.replacingPoster = index;
    $('#posterReplace').click();
  }
});
$('#posterFiles').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  if (state.posters.length + files.length > MAX_POSTERS) return status(`橫幅最多 ${MAX_POSTERS} 張`, true);
  try {
    status('上傳圖片中…');
    for (const file of files) state.posters.push({ id: '', url: await uploadPoster(file) });
    renderPosters();
    status('圖片已加入，按儲存後才會更新主頁');
  } catch (error) {
    status(error.message, true);
  }
});
$('#posterReplace').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  const index = state.replacingPoster;
  event.target.value = '';
  state.replacingPoster = null;
  if (!file || index == null || !state.posters[index]) return;
  try {
    status('上傳圖片中…');
    state.posters[index] = { id: state.posters[index].id, url: await uploadPoster(file) };
    renderPosters();
    status('圖片已換上，按儲存後才會更新主頁');
  } catch (error) {
    status(error.message, true);
  }
});
$('#newsBoard').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.add) return openEditor({ category: button.dataset.add, images: [] });
    if (button.dataset.edit) return openEditor(state.content.news.find((item) => item.id === button.dataset.edit));
    if (button.dataset.delete) {
      const item = state.content.news.find((entry) => entry.id === button.dataset.delete);
      if (!item || !window.confirm(`刪除「${item.title}」？`)) return;
      await newsAction({ action: 'delete', id: item.id });
      return;
    }
    if (button.dataset.move) await newsAction({ action: 'move', id: button.dataset.id, direction: button.dataset.move });
  } catch (error) {
    status(error.message, true);
  }
});

$('#newsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await newsAction({
      action: state.editing?.id ? 'update' : 'create',
      id: state.editing?.id,
      category: $('#newsCategory').value,
      title: $('#newsTitle').value,
      publishedOn: $('#newsPublished').value,
      updatedOn: $('#newsUpdated').value,
      publisher: $('#newsPublisher').value,
      body: $('#newsBody').value,
      images: state.images
    });
    $('#editor').close();
  } catch (error) {
    status(error.message, true);
  }
});

$('#newsPhotos').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  try {
    status('上傳照片中…');
    await uploadImages(files);
    status('照片已加入，請按儲存新聞');
  } catch (error) {
    status(error.message, true);
  }
});

$('#newsImages').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-image]');
  if (!button) return;
  state.images.splice(Number(button.dataset.removeImage), 1);
  renderImages();
});

$('#closeEditor').addEventListener('click', () => $('#editor').close());

api('/api/me').then((me) => {
  if (me.user?.role !== 'admin') return;
  hide('#loginPanel');
  show('#workspace');
  $('#logoutButton').classList.remove('hidden');
  $('#who').textContent = me.user.displayName || me.user.username;
  return loadContent();
}).catch((error) => status(error.message, true));
