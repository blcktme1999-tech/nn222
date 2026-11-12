'use strict';

// REST is the source of truth, including on hosts without Socket.IO. Never fake
// an authenticated session, message, upload or call when the server is offline.
const state = {
  me: null, currentCase: null, cases: [], detailRoot: null, callRoot: null,
  citizenCases: [],
  videoSession: null, mediaError: '', mediaPending: false,
  conversation: null, viewVersion: 0, caseRevision: 0,
  workflow: Promise.resolve(), caseLoad: null,
  casePollTimer: null, messagePollTimer: null,
  interviewLocked: false, leavingInterview: false
};
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
// Controller failures also reject public operations. Do not cache those rejects
// as workflow errors: lastError remains the controller's source of truth.
const controllerErrors = new WeakSet();
const TAB_SESSION_KEY = 'cib-service-tab';
const $ = (selector, root = document) => root?.querySelector(selector) || null;
const $$ = (selector, root = document) => [...(root?.querySelectorAll(selector) || [])];
const casePath = (caseId, suffix = '') => `/api/cases/${encodeURIComponent(caseId)}${suffix}`;
const postOptions = (body) => ({ method: 'POST', body: JSON.stringify(body) });

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers }
    });
  } catch (_) {
    throw new Error('無法連線至伺服器，操作尚未確認完成。請檢查網路後重試。');
  }
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    throw new Error('伺服器未回傳有效 JSON，操作尚未確認完成。請稍後重試。');
  }
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('伺服器回應格式錯誤，請稍後重試。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('伺服器回應格式錯誤。');
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '操作失敗，請稍後再試。');
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '時間未提供' : date.toLocaleString('zh-TW', { hour12: false });
}

function displayMessage(value) {
  const replacements = {
    '客服訊息紀錄': '案件訊息紀錄',
    '民眾已送出線上客服開通申請，等待管理員審核。': '民眾已送出線上報案開通申請，等待審核。',
    '管理員已開通線上客服服務。': '已開通線上報案系統。',
    '管理員已開通線上客服系統。': '已開通線上報案系統。',
    '管理員已預先開通線上客服服務。': '已預先開通線上報案系統。',
    'Agora 房間': '案號/報案編號', '進入線上客服': '我要線上筆錄'
  };
  return replacements[value] || String(value ?? '');
}

function displaySenderName(message) {
  const name = String(message?.senderName ?? '');
  return message?.senderType === 'system' || name === '系統' || name === '系統管理員' ? '警政系統' : name;
}

function displayCaseNumber(caseItem) {
  const caseNumber = String(caseItem?.caseNumber || '').trim();
  if (caseNumber) return caseNumber;
  const date = new Date(caseItem?.createdAt);
  const year = Number.isNaN(date.getTime()) ? new Date().getFullYear() : date.getFullYear();
  let hash = 0;
  for (const char of String(caseItem?.id || '')) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  const serial = String((hash % 900000) + 100000).padStart(6, '0');
  return `${year - 1911}年度受理字${serial}號`;
}

function displayCaseField(value) {
  const text = String(value || '').trim();
  return text || '未填寫';
}

function signatureBlock(caseItem) {
  const block = (value, label) => {
    const src = String(value || '');
    if (!src.startsWith('data:image/png;base64,')) return '';
    return `<div class="summary-box summary-wide">${label}<img alt="${label}" src="${src}" style="display:block;max-width:280px;background:#fff;border:1px solid #ddd"></div>`;
  };
  return block(caseItem?.interviewSignature, '保證筆錄是如實回答') + block(caseItem?.documentSignature, '本人簽名');
}

function caseSummaryPreview(caseItem) {
  const text = displayCaseField(caseItem?.documentCase || caseItem?.caseSummary);
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

function errorText(error) {
  return error?.message || '操作失敗，請稍後再試。';
}

function inlineNotice(root, text, slot = 'actionError') {
  if (!root) return;
  let notice = $(`[data-slot="${slot}"]`, root);
  if (!notice) {
    notice = document.createElement('div');
    notice.dataset.slot = slot;
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    root.appendChild(notice);
  }
  notice.className = 'notice error';
  notice.textContent = text;
  notice.hidden = !text;
}

function showNotice(text, type = 'info') {
  const notice = $('#citizenStatus');
  if (!notice) return;
  notice.textContent = text;
  notice.className = text ? `notice ${type}` : 'notice hidden';
}

function reportActionError(error, root = state.detailRoot || $('#staffLogin')) {
  if (error?.name !== 'AbortError') inlineNotice(root, errorText(error));
}

// Selection, device operations, status changes and session changes share one
// queue. In-flight token/capture operations finish before their root is replaced.
function enqueueWorkflow(operation) {
  const result = state.workflow.then(operation);
  state.workflow = result.catch(() => {});
  return result;
}

function activatePanel(panelId) {
  $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === panelId));
  $$('.tab-button').forEach((button) => button.classList.toggle('active', button.dataset.panel === panelId));
  const hash = { citizenPanel: 'citizen', staffPanel: 'staff', adminPanel: 'admin' }[panelId];
  if (hash) window.history.replaceState(null, '', `#${hash}`);
}

function caseStatus(caseItem) {
  if (caseItem.status === 'closed') return '已結案';
  return caseItem.interviewStatus === 'active' ? '筆錄中' : '已開通';
}

function statusClass(caseItem) {
  return caseItem.status === 'open' && caseItem.interviewStatus === 'active' ? 'active' :
    ['pending', 'open', 'closed'].includes(caseItem.status) ? caseItem.status : 'pending';
}

function filterCaseItems(cases, isAdmin, search = '', filter = 'all') {
  const term = search.trim().toLocaleLowerCase();
  return cases.filter((item) => (isAdmin || item.status === 'open') &&
    (!term || [item.citizenName, item.id, item.caseNumber, item.certificateNumber, item.nationalId, item.agoraChannel, displayCaseNumber(item)]
      .some((value) => String(value || '').toLocaleLowerCase().includes(term))) &&
    (filter === 'all' || (filter === 'active' ? item.status === 'open' && item.interviewStatus === 'active' : item.status === filter)));
}

function renderWantedRecords(panel, records) {
  const list = $('[data-slot="wantedList"]', panel);
  if (!list) return;
  list.innerHTML = records.length ? '' : '<p class="muted">尚未建立通緝資料。</p>';
  records.forEach((record) => {
    const item = document.createElement('article');
    item.className = 'wanted-record';
    const photo = record.photoUrl ? `<img src="${escapeHtml(record.photoUrl)}" alt="">` : '<span class="muted">未提供照片</span>';
    item.innerHTML = `${photo}<div><strong>${escapeHtml(record.personName)}</strong><div class="meta">${escapeHtml(record.nationalId || '')}</div><p>${escapeHtml(record.reason)}</p></div><button type="button" class="secondary" data-action="deleteWanted" data-id="${escapeHtml(record.id)}">刪除</button>`;
    list.appendChild(item);
  });
}

async function loadWantedRecords(panel) {
  const data = await api('/api/wanted');
  renderWantedRecords(panel, Array.isArray(data.records) ? data.records : []);
}

function ensureWantedPanel(root) {
  if (!root || $('[data-slot="wantedPanel"]', root)) return;
  const panel = document.createElement('section');
  panel.className = 'surface wanted-panel';
  panel.dataset.slot = 'wantedPanel';
  panel.innerHTML = `<div class="section-heading"><h2>通緝資料</h2></div>
    <p class="muted">建立通緝資料時，請輸入身分證字號、姓名與通緝事由。</p>
    <form class="stacked-form wanted-form">
      <label>身分證字號<input name="nationalId" required autocomplete="off"></label>
      <label>姓名<input name="personName" required></label>
      <label>通緝事由<textarea name="reason" required></textarea></label>
      <label>照片<input name="photo" type="file" accept="image/*"></label>
      <button type="submit">建立通緝資料</button>
    </form>
    <div data-slot="wantedList"></div>`;
  root.insertBefore(panel, root.firstChild);
  $('form', panel).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const field = (name) => String(form.elements.namedItem(name)?.value || '').trim();
    const nationalId = field('nationalId');
    const personName = field('personName');
    const reason = field('reason');
    if (!nationalId || !personName || !reason) {
      inlineNotice(panel, '請輸入身分證字號、姓名與通緝事由');
      return;
    }
    try {
      const photo = form.elements.namedItem('photo')?.files?.[0];
      let photoDataUrl = '';
      if (photo) {
        if (!photo.type.startsWith('image/')) throw new Error('照片只接受圖片');
        if (photo.size > 2 * 1024 * 1024) throw new Error('照片上限為 2 MB');
        photoDataUrl = await readFileAsDataUrl(photo);
      }
      await api('/api/wanted', postOptions({
        nationalId,
        personName,
        reason,
        photoDataUrl
      }));
      form.reset();
      await loadWantedRecords(panel);
      inlineNotice(panel, '');
    } catch (error) {
      inlineNotice(panel, errorText(error));
    }
  });
  panel.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="deleteWanted"]');
    if (!button) return;
    if (!window.confirm('確定刪除這筆通緝資料？')) return;
    try {
      await api(`/api/wanted/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
      await loadWantedRecords(panel);
    } catch (error) {
      inlineNotice(panel, errorText(error));
    }
  });
  loadWantedRecords(panel).catch((error) => inlineNotice(panel, errorText(error)));
}

function renderCaseShell(root, cases, isAdmin) {
  if (!root) return;
  ensureWantedPanel(root);
  if (!$('[data-slot="caseList"]', root)) {
    const template = $('#caseWorkspaceTemplate');
    if (!template) throw new Error('案件範本尚未載入。');
    root.appendChild(template.content.cloneNode(true));
    $('[data-action="refreshCases"]', root)?.addEventListener('click', () => loadCases().catch((error) => reportActionError(error, root)));
    $('[data-action="searchCases"]', root)?.addEventListener('input', () => renderCaseList(root, state.cases, isAdmin));
    $('[data-action="filterCases"]', root)?.addEventListener('change', () => renderCaseList(root, state.cases, isAdmin));
  }
  renderCaseList(root, cases, isAdmin);
}

function renderCaseList(root, cases, isAdmin) {
  const list = $('[data-slot="caseList"]', root);
  if (!list) return;
  const visible = filterCaseItems(cases, isAdmin, $('[data-action="searchCases"]', root)?.value,
    $('[data-action="filterCases"]', root)?.value || 'all');
  const count = $('[data-slot="caseCount"]', root);
  if (count) count.textContent = String(visible.length);
  const scrollTop = list.scrollTop;
  list.innerHTML = visible.length ? '' : '<p class="muted">目前沒有符合條件的案件。</p>';
  visible.forEach((caseItem) => {
    const card = document.createElement('article');
    card.className = `case-card ${state.currentCase?.id === caseItem.id ? 'active' : ''}`;
    card.innerHTML = `<button type="button" class="case-card-main" aria-pressed="${state.currentCase?.id === caseItem.id}">
        <span class="case-name-row"><strong>${escapeHtml(caseItem.citizenName)}</strong><span class="case-add-spacer"></span></span>
        <div class="meta"><span class="status ${statusClass(caseItem)}">${caseStatus(caseItem)}</span> · ${escapeHtml(formatTime(caseItem.createdAt))}</div>
        <div class="meta case-number">${escapeHtml(displayCaseNumber(caseItem))}</div>
      </button>
      <button type="button" class="case-add-button" data-action="createRelatedCase">＋新增案件</button>`;
    $('.case-card-main', card).addEventListener('click', () => selectCase(root, caseItem, isAdmin).catch((error) => reportActionError(error, root)));
    $('[data-action="createRelatedCase"]', card).addEventListener('click', () => renderCreateRelatedCase(root, caseItem, isAdmin));
    list.appendChild(card);
  });
  list.scrollTop = scrollTop;
}

function renderCreateRelatedCase(root, sourceCase, isAdmin = false) {
  const summary = $('[data-slot="caseSummary"]', root);
  const conversation = $('[data-slot="conversation"]', root);
  const media = $('[data-slot="media"]', root);
  if (!summary || !conversation || !media) return;
  clearInterval(state.messagePollTimer);
  for (const node of [conversation, media]) { node.replaceChildren(); node.classList.add('hidden'); }
  summary.classList.remove('hidden', 'empty-state');
  summary.dataset.caseId = '';
  summary.innerHTML = `<div class="section-heading"><h2>新增案件</h2></div>
    <form class="stacked-form create-related-case-form">
      <label>姓名<input name="citizenName" value="${escapeHtml(sourceCase.citizenName || '')}" required></label>
      <label>證號<input name="certificateNumber" value="${escapeHtml(sourceCase.certificateNumber || '')}" required></label>
      <label>案號/報案編號<input name="caseNumber" placeholder="留空由後端自動產生"></label>
      <label>案件類型<input name="caseType" required></label>
      <label>案件標題<input name="caseTitle" required></label>
      <label>案件說明<textarea name="caseSummary" required></textarea></label>
      <label>案件公文-案件<textarea name="documentCase" placeholder="預留案件欄位"></textarea></label>
      <label>案件公文-公文<textarea name="documentOfficial" placeholder="預留公文欄位"></textarea></label>
      <label>案件公文-內容<textarea name="documentContent" placeholder="預留內容欄位"></textarea></label>
      <button type="submit">新增案件</button>
    </form>`;
  const form = $('.create-related-case-form', summary);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitAdminForm(form, async () => {
      const value = (name) => form.elements.namedItem(name).value;
      const data = await api('/api/cases', postOptions({
        citizenName: value('citizenName'),
        certificateNumber: value('certificateNumber'),
        caseNumber: value('caseNumber'),
        caseType: value('caseType'),
        caseTitle: value('caseTitle'),
        caseSummary: value('caseSummary'),
        documentCase: value('documentCase'),
        documentOfficial: value('documentOfficial'),
        documentContent: value('documentContent')
      }));
      if (!data.case?.id) throw new Error('新增案件結果不完整，請重新整理確認。');
      state.caseRevision += 1;
      state.cases = [data.case, ...state.cases.filter((item) => item.id !== data.case.id)];
      renderAllCaseLists();
      inlineNotice(summary, '新增成功', 'createCaseStatus');
      await selectCaseNow(root, data.case, isAdmin);
    });
  });
}

function renderAllCaseLists() {
  renderCaseList($('#staffWorkspace'), state.cases, false);
  if (state.me?.user?.role === 'admin') renderCaseList($('#adminWorkspace'), state.cases, true);
  renderCitizenCaseList($('#citizenWorkspace'));
}

function renderCitizenCaseList(root = $('#citizenWorkspace')) {
  const list = $('[data-slot="citizenCaseList"]', root);
  if (!list) return;
  const cases = state.citizenCases || [];
  if (!cases.length) { list.innerHTML = ''; return; }
  list.innerHTML = `<div class="section-heading"><h2>我的案件</h2></div><div class="citizen-case-cards"></div>`;
  const cards = $('.citizen-case-cards', list);
  cases.forEach((caseItem) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `case-card citizen-case-card ${state.currentCase?.id === caseItem.id ? 'active' : ''}`;
    button.setAttribute('aria-pressed', String(state.currentCase?.id === caseItem.id));
    button.innerHTML = `<strong>${escapeHtml(displayCaseNumber(caseItem))}</strong>
      <div class="meta"><span class="status ${statusClass(caseItem)}">${caseStatus(caseItem)}</span> · ${escapeHtml(formatTime(caseItem.createdAt))}</div>
      <div class="meta">${escapeHtml(caseSummaryPreview(caseItem))}</div>`;
    button.addEventListener('click', () => selectCase(root, caseItem, false).catch((error) => reportActionError(error, root)));
    cards.appendChild(button);
  });
}

async function refreshCitizenCases() {
  if (state.me?.user) return;
  const docsOpen = Boolean($('#citizenDocs')?.isConnected);
  if (!docsOpen && !state.me?.case) return;
  const session = await api('/api/me');
  const listed = Array.isArray(session.cases) ? session.cases : [];
  state.citizenCases = listed.length ? listed : session.case ? [session.case] : [];
  if (session.case || session.user) state.me = session;
  const currentId = state.currentCase?.id;
  const fresh = [session.case, ...listed].find((item) => item && String(item.id) === String(currentId)) || (!currentId ? session.case : null);
  if (fresh) await applySelectedCase(fresh);
  if (!docsOpen) renderCitizenCaseList($('#citizenWorkspace'));
  const images = $('[data-slot="docImages"]');
  if (images && state.currentCase?.id) void loadDocImages(state.currentCase.id, images);
}

function startCitizenCasePolling() {
  clearInterval(state.casePollTimer);
  state.casePollTimer = setInterval(() => { refreshCitizenCases().catch((error) => showNotice(errorText(error), 'error')); }, 3000);
}

function isCurrentRoot(caseId, root = state.callRoot) {
  return Boolean(root?.isConnected && root === state.callRoot && root.dataset.caseId === String(caseId) && state.currentCase?.id === caseId);
}

function requireOpenRoot(caseId, root) {
  if (!isCurrentRoot(caseId, root)) throw new Error('案件已切換，請在目前案件重新操作。');
  if (state.currentCase.status === 'closed') throw new Error('案件已結案，無法使用視訊。');
}

function selectCase(root, caseItem, isAdmin = false) {
  return enqueueWorkflow(() => selectCaseNow(root, state.cases.find((item) => item.id === caseItem.id) || caseItem, isAdmin));
}

async function selectCaseNow(root, caseItem, isAdmin = false) {
  if (!root?.isConnected) return false;
  if (state.currentCase?.id === caseItem.id && state.detailRoot === root) {
    await applySelectedCase(caseItem);
    return true;
  }
  if (state.videoSession?.hasLocalMedia && !window.confirm('切換案件將關閉我方攝影機與麥克風，並中斷目前視訊。新案件只接收對方視訊，不會自動開啟我方裝置。是否繼續？')) return false;
  await disconnectCurrent();
  const previousRoot = state.detailRoot;
  state.viewVersion += 1;
  state.conversation = null;
  clearInterval(state.messagePollTimer);
  if (previousRoot && previousRoot !== root) {
    for (const slot of ['caseSummary', 'conversation', 'media']) {
      const node = $(`[data-slot="${slot}"]`, previousRoot);
      if (node) { node.replaceChildren(); node.classList.add('hidden'); }
    }
  }
  state.currentCase = caseItem;
  state.detailRoot = root;
  state.mediaError = '';
  root.classList.remove('hidden');
  if (root.id === 'citizenWorkspace' && !$('[data-slot="caseSummary"]', root)) {
    root.innerHTML = '<div data-slot="citizenCaseList" class="surface citizen-case-list"></div><div class="case-detail"><div data-slot="caseSummary" class="surface"></div><div data-slot="media" class="surface"></div><div data-slot="conversation" class="surface"></div></div>';
  }
  renderCaseDetail(root, caseItem, isAdmin);
  renderAllCaseLists();
  return true;
}

async function renderCitizenWorkspace(caseItem) {
  const cases = Array.isArray(caseItem) ? caseItem : [caseItem].filter(Boolean);
  state.citizenCases = cases;
  const selected = state.currentCase && cases.find((item) => item.id === state.currentCase.id) || cases[0];
  renderCitizenCaseList($('#citizenWorkspace'));
  return selected ? selectCaseNow($('#citizenWorkspace'), selected, false) : false;
}

function openCaseDetail(root, _cases, caseItem, isAdmin) {
  return selectCase(root, caseItem, isAdmin);
}

function renderCaseDetail(root, caseItem, isAdmin) {
  const summary = $('[data-slot="caseSummary"]', root);
  const conversation = $('[data-slot="conversation"]', root);
  const media = $('[data-slot="media"]', root);
  if (!summary || !conversation || !media) throw new Error('案件工作區尚未準備完成。');
  for (const node of [summary, conversation, media]) { node.classList.remove('hidden', 'empty-state'); node.dataset.caseId = String(caseItem.id); }
  summary.innerHTML = `<div class="section-heading"><h2>${escapeHtml(caseItem.citizenName)}</h2>
    <span>${isAdmin ? '<button type="button" data-action="approve" class="warning">審核開通</button>' : ''}${state.me?.user ? '<button type="button" data-action="deleteCase" class="warning">刪除案件</button>' : ''}</span></div>
    <div class="summary-grid">
      <div class="summary-box">案號/報案編號<strong>${escapeHtml(displayCaseNumber(caseItem))}</strong></div>
      <div class="summary-box">證號<strong>${escapeHtml(displayCaseField(caseItem.certificateNumber))}</strong></div>
      <div class="summary-box">狀態<strong data-slot="caseStatus"></strong></div>
      <div class="summary-box">建立時間<strong>${escapeHtml(formatTime(caseItem.createdAt))}</strong></div>
      <div class="summary-box">案件類型<strong>${escapeHtml(displayCaseField(caseItem.caseType))}</strong></div>
      <div class="summary-box">案件標題<strong>${escapeHtml(displayCaseField(caseItem.caseTitle))}</strong></div>
      <div class="summary-box summary-wide">案件說明<strong>${escapeHtml(displayCaseField(caseItem.caseSummary))}</strong></div>
      <div class="summary-box summary-wide">案件公文-案件<strong>${escapeHtml(displayCaseField(caseItem.documentCase))}</strong></div>
      <div class="summary-box summary-wide">案件公文-公文<strong>${escapeHtml(displayCaseField(caseItem.documentOfficial))}</strong></div>
      <div class="summary-box summary-wide">案件公文-內容<strong>${escapeHtml(displayCaseField(caseItem.documentContent))}</strong></div>
      <div class="summary-box summary-wide">案由<strong>${escapeHtml(displayCaseField(caseItem.caseReason))}</strong></div>
      <div class="summary-box summary-wide">單位<strong>${escapeHtml(displayCaseField(caseItem.caseUnit))}</strong></div>
      <div class="summary-box summary-wide">命令<strong>${escapeHtml(displayCaseField(caseItem.caseOrder))}</strong></div>
      ${signatureBlock(caseItem)}
    </div>
    ${state.me?.user ? `<form class="stacked-form document-edit-form section-card">
      <h3>編輯案件公文</h3>
      <label>公文<textarea name="documentOfficial">${escapeHtml(caseItem.documentOfficial || '')}</textarea></label>
      <label>案由<textarea name="caseReason">${escapeHtml(caseItem.caseReason || '')}</textarea></label>
      <label>單位<input name="caseUnit" value="${escapeHtml(caseItem.caseUnit || '')}"></label>
      <button type="submit">儲存案件公文</button>
    </form>
    <section class="document-files section-card">
      <h3>案件附件</h3>
      <div data-slot="documentFiles"><p class="muted">尚無附件</p></div>
      <form class="document-file-form stacked-form">
        <label>上傳給民眾在案件公文打開的檔案（Excel 或其他檔案，每個最多 20 MB）<input name="file" type="file" required></label>
        <button type="submit">上傳檔案</button>
      </form>
    </section>` : ''}`;
  $('[data-action="deleteCase"]', summary)?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const label = `${caseItem.citizenName} ${displayCaseNumber(caseItem)}`.trim();
    if (!window.confirm(`確定刪除「${label}」？這筆案件的公文與附件會一併刪除。`)) return;
    button.disabled = true;
    enqueueWorkflow(async () => {
      if (state.detailRoot !== root || state.currentCase?.id !== caseItem.id) return;
      await api(casePath(caseItem.id), { method: 'DELETE' });
      if (state.videoSession) await state.videoSession.disconnect();
      clearInterval(state.messagePollTimer);
      state.conversation = null;
      state.currentCase = null;
      state.detailRoot = null;
      state.caseRevision += 1;
      state.cases = state.cases.filter((item) => item.id !== caseItem.id);
      for (const slot of ['caseSummary', 'conversation', 'media']) {
        const node = $(`[data-slot="${slot}"]`, root);
        if (!node) continue;
        node.replaceChildren();
        node.classList.add('hidden');
        if (slot === 'caseSummary') {
          node.textContent = '請選擇案件';
          node.classList.add('empty-state');
          node.classList.remove('hidden');
        }
      }
      renderAllCaseLists();
    }).catch((error) => reportActionError(error, summary)).finally(() => {
      if (button.isConnected) button.disabled = false;
    });
  });
  $('[data-action="approve"]', summary)?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    enqueueWorkflow(async () => {
      if (state.detailRoot !== root || state.currentCase?.id !== caseItem.id) return;
      const data = await api(casePath(caseItem.id, '/approve'), { method: 'POST' });
      if (!data.case || data.case.id !== caseItem.id) throw new Error('審核結果不完整，請重新整理確認。');
      state.caseRevision += 1;
      state.cases = state.cases.map((item) => item.id === caseItem.id ? data.case : item);
      await applySelectedCase(data.case);
      renderAllCaseLists();
      await refreshMessages(caseItem.id);
    }).catch((error) => reportActionError(error, summary)).finally(() => { button.disabled = false; });
  });
  $('.document-edit-form', summary)?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    void submitAdminForm(form, async () => {
      const value = (name) => form.elements.namedItem(name).value;
      const data = await api(casePath(caseItem.id, '/details'), {
        method: 'PATCH',
        body: JSON.stringify({
          documentOfficial: value('documentOfficial'),
          caseReason: value('caseReason'),
          caseUnit: value('caseUnit')
        })
      });
      if (!data.case?.id) throw new Error('案件公文更新結果不完整，請重新整理確認。');
      state.caseRevision += 1;
      state.cases = state.cases.map((item) => item.id === data.case.id ? data.case : item);
      await applySelectedCase(data.case);
      renderCaseDetail(root, data.case, isAdmin);
      renderAllCaseLists();
      inlineNotice($('[data-slot="caseSummary"]', root), '案件公文已儲存', 'documentEditStatus');
    });
  });
  const fileForm = $('.document-file-form', summary);
  fileForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = fileForm.elements.namedItem('file');
    const file = input.files?.[0];
    if (!file) return;
    void submitAdminForm(fileForm, async () => {
      const saved = await uploadStaffFile(casePath(caseItem.id, '/files'), file);
      if (saved && state.conversation) mergeConversation(state.conversation, [], [saved]);
      fileForm.reset();
      await loadDocumentFiles(summary, caseItem);
      inlineNotice(fileForm, '檔案已上傳，民眾查詢案件公文時可以打開。', 'documentFileStatus');
    });
  });
  summary.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-action="deleteDocumentFile"]');
    if (!button || !summary.contains(button)) return;
    button.disabled = true;
    api(casePath(caseItem.id, '/files'), postOptions({ action: 'delete', fileId: button.dataset.fileId }))
      .then(() => loadDocumentFiles(summary, caseItem))
      .catch((error) => reportActionError(error, summary))
      .finally(() => { button.disabled = false; });
  });
  if (fileForm) void loadDocumentFiles(summary, caseItem);
  if (!isAdmin && media?.parentElement) {
    let docs = $('[data-slot="citizenDocs"]', root);
    if (!docs) {
      docs = document.createElement('aside');
      docs.dataset.slot = 'citizenDocs';
      docs.className = 'surface citizen-docs';
      media.parentElement.insertBefore(docs, media);
    }
    const cell = (value) => escapeHtml(displayCaseField(value));
    docs.innerHTML = `<h3>本案</h3><table class="citizen-doc-table"><tbody>
      <tr><th>公文</th><td>${cell(caseItem.documentOfficial)}</td></tr>
      <tr><th>案由</th><td>${cell(caseItem.caseReason)}</td></tr>
      <tr><th>單位</th><td>${cell(caseItem.caseUnit)}</td></tr>
    </tbody></table><div data-slot="docImages" class="doc-images"></div>`;
    void loadDocImages(caseItem.id, $('[data-slot="docImages"]', docs));
  }
  renderConversation(conversation, caseItem);
  renderMedia(media, caseItem);
  updateSummary(caseItem);
}

function updateSummary(caseItem) {
  const badge = $('[data-slot="caseStatus"]', state.detailRoot);
  if (badge) { badge.textContent = caseStatus(caseItem); badge.className = `status ${statusClass(caseItem)}`; }
  const approve = $('[data-action="approve"]', state.detailRoot);
  if (approve) approve.hidden = true;
}

async function applySelectedCase(caseItem) {
  if (String(state.currentCase?.id) !== String(caseItem.id)) return;
  const oldStatus = state.currentCase.status;
  state.currentCase = caseItem;
  updateSummary(caseItem);
  updateConversationControls(state.conversation);
  if (caseItem.status === 'closed' && state.videoSession?.caseId === caseItem.id) await state.videoSession.disconnect();
  renderMediaState();
  paintCitizenDocs(caseItem);
}

function getVideoSession() {
  if (!state.videoSession) {
    if (!window.ReportVideoSession) throw new Error('視訊控制器尚未載入，請重新整理後再試。');
    state.videoSession = new window.ReportVideoSession({
      getToken: (caseId) => {
        requireOpenRoot(caseId, state.callRoot);
        return api(casePath(caseId, '/agora-token'), { method: 'POST' });
      },
      onChange: () => { renderMediaState(); void endStatementIfCallStopped(); releaseCitizenInterviewIfCameraOff(); },
      onError: (error) => { controllerErrors.add(error); renderMediaState(); }
    });
  }
  return state.videoSession;
}

function showMediaError(error) {
  if (error?.name === 'AbortError') return;
  if (!controllerErrors.has(error)) state.mediaError = errorText(error);
  renderMediaState();
}

let cameraPreviewStream = null;

function stopCameraPreview() {
  const stream = cameraPreviewStream;
  cameraPreviewStream = null;
  stream?.getTracks().forEach((track) => track.stop());
  state.callRoot?.querySelector('[data-camera-preview]')?.remove();
}

async function previewSelectedCamera(deviceId, root, caseId) {
  stopCameraPreview();
  const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false });
  if (!isCurrentRoot(caseId, root) || state.videoSession?.tracks.has('video')) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  const player = $('[data-slot="localPlayer"]', root);
  if (!player) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  cameraPreviewStream = stream;
  const video = document.createElement('video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('data-camera-preview', 'true');
  video.srcObject = stream;
  player.replaceChildren(video);
  video.play?.().catch(() => {});
}

function renderMedia(root, caseItem) {
  stopCameraPreview();
  state.callRoot = root;
  root.dataset.caseId = String(caseItem.id);
  const staff = Boolean(state.me?.user);
  root.innerHTML = `<div class="section-heading"><h2>線上筆錄</h2></div>
    <div class="media-grid"><div class="media-controls">
      <div data-slot="videoGrid" class="video-grid video-pair">
        <p class="visually-hidden" data-slot="statementLive" role="status"></p>
        <div class="video-tile"><div data-slot="localVideoSlot" class="video-slot"><div data-slot="localPlayer" class="video-player"></div></div><div data-slot="localLabel" class="video-label">${staff ? '承辦人' : '民眾'}</div></div>
        <div data-slot="remotePlaceholder" class="video-tile"><div class="video-slot video-placeholder"><p>${staff ? '等待民眾進入筆錄' : '等待承辦人進入筆錄'}</p></div><div class="video-label">${staff ? '民眾' : '承辦人'}</div></div>
      </div>
      <p data-slot="callStatus" class="call-status" role="status" aria-live="polite"></p>
      <p data-slot="recordingNotice" class="recording-notice">尚未進入筆錄</p>
      <div data-slot="mediaError" class="notice error" role="status" aria-live="polite" hidden></div>
      ${staff ? `<div class="camera-picker" data-slot="cameraPicker">
        <button type="button" class="camera-select" data-action="chooseCamera" aria-haspopup="listbox" aria-expanded="false">
          <span class="camera-select-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9 7.5 10.2 6h3.6L15 7.5h2.2A1.8 1.8 0 0 1 19 9.3v7.4a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 16.7V9.3a1.8 1.8 0 0 1 1.8-1.8H9Zm3 2.2a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2Z"/></svg></span>
          <span data-slot="cameraName">選擇鏡頭</span>
          <span class="camera-select-chevron" aria-hidden="true"></span>
        </button>
        <ul class="camera-menu" data-slot="cameraMenu" role="listbox" hidden></ul>
      </div>` : ''}
      <div class="button-row">
        ${!staff && root.closest('.interview-live') ? `<button type="button" data-action="endInterview" class="warning">結束筆錄</button>` : `<button type="button" data-action="joinCall" class="warning">進入筆錄</button>
        <button type="button" data-action="toggleVideo" class="secondary" aria-pressed="false">開啟鏡頭</button>
        <button type="button" data-action="retryMedia" class="secondary" hidden>重試視訊</button>`}
        <button type="button" data-action="toggleAudio" class="secondary" aria-pressed="false">開啟麥克風</button>
        <button type="button" data-action="resumeAudio" class="secondary">播放聲音</button>
      </div>
    </div></div>`;
  const mediaAction = (operation) => runMediaAction(caseItem.id, root, operation).catch(showMediaError);
  $('[data-action="joinCall"]', root)?.addEventListener('click', () => mediaAction(() => joinCall(caseItem.id, true, false, root)));
  $('[data-action="endInterview"]', root)?.addEventListener('click', () => {
    if (!window.confirm('結束筆錄會關閉鏡頭。下次必須重新填寫、選案件並簽名。確定結束？')) return;
    void exitCitizenInterview('已結束筆錄。要再次筆錄請重新進入。', 'info');
  });
  $('[data-action="leaveCall"]', root)?.addEventListener('click', () => mediaAction(() => leaveCall(caseItem.id, true)));
  for (const [action, kind] of [['toggleVideo', 'video'], ['toggleAudio', 'audio']]) {
    $(`[data-action="${action}"]`, root)?.addEventListener('click', () => mediaAction(async () => {
      const session = getVideoSession();
      const enabled = !session.tracks.has(kind);
      if (enabled && kind === 'video') stopCameraPreview();
      if (enabled) await session.connect(caseItem.id, root);
      await session.setDevice(kind, enabled);
      if (!staff) await updateStatementStatus(caseItem.id, session.hasLocalMedia);
    }));
  }
  $('[data-action="retryMedia"]', root)?.addEventListener('click', () => mediaAction(() => joinCall(caseItem.id, true, false, root)));
  const cameraButton = $('[data-action="chooseCamera"]', root);
  const cameraMenu = $('[data-slot="cameraMenu"]', root);
  if (cameraButton && cameraMenu && root.dataset.cameraBound !== '1') {
    root.dataset.cameraBound = '1';
    root.addEventListener('click', (event) => {
      const menu = $('[data-slot="cameraMenu"]', root);
      const button = $('[data-action="chooseCamera"]', root);
      if (!menu || menu.hidden || event.target.closest('[data-slot="cameraPicker"]')) return;
      menu.hidden = true;
      button?.setAttribute('aria-expanded', 'false');
    });
  }
  cameraButton?.addEventListener('click', () => {
    if (cameraMenu.hidden) {
      getVideoSession().listCameras().then((cameras) => {
        if (!isCurrentRoot(caseItem.id, root)) return;
        const current = state.videoSession?.preferredCameraId || '';
        cameraMenu.replaceChildren();
        cameras.forEach((camera) => {
          const item = document.createElement('li');
          const option = document.createElement('button');
          option.type = 'button';
          option.setAttribute('role', 'option');
          option.dataset.deviceId = camera.deviceId;
          option.setAttribute('aria-selected', camera.deviceId === current ? 'true' : 'false');
          option.textContent = camera.label;
          option.addEventListener('click', (event) => {
            event.stopPropagation?.();
            cameraMenu.hidden = true;
            cameraButton.setAttribute('aria-expanded', 'false');
            const deviceId = option.dataset.deviceId;
            const label = option.textContent.trim();
            mediaAction(async () => {
              const session = getVideoSession();
              await session.useCamera(deviceId, label);
              if (!session.tracks.has('video')) await previewSelectedCamera(deviceId, root, caseItem.id);
            });
          });
          item.appendChild(option);
          cameraMenu.appendChild(item);
        });
        cameraMenu.hidden = false;
        cameraButton.setAttribute('aria-expanded', 'true');
      }).catch(showMediaError);
      return;
    }
    cameraMenu.hidden = true;
    cameraButton.setAttribute('aria-expanded', 'false');
  });
  $('[data-action="resumeAudio"]', root).addEventListener('click', () => {
    if (!isCurrentRoot(caseItem.id, root)) return;
    // Do not queue: audio.play() must execute inside this user gesture.
    const session = state.videoSession;
    if (!session) return;
    session.resumeAudio().catch(showMediaError);
  });
  renderMediaState();
}

function renderMediaState() {
  const root = state.callRoot;
  if (!isCurrentRoot(state.currentCase?.id, root)) return;
  const session = state.videoSession;
  const same = session?.caseId === state.currentCase.id;
  const connected = Boolean(same && session.connected);
  const busy = state.mediaPending || Boolean(session?.busy);
  const open = state.currentCase.status !== 'closed';
  // Failed connect cleans caseId/root before reporting its error.
  const error = state.mediaError || ((same || session?.caseId === null) && session.lastError ? errorText(session.lastError) : '');
  const placeholder = $('[data-slot="remotePlaceholder"]', root);
  // CSS's .video-tile display rules must not make a hidden waiting tile visible.
  placeholder?.classList.toggle('hidden', Boolean(placeholder.hidden));
  const status = $('[data-slot="callStatus"]', root);
  if (status) status.textContent = !open ? '案件已結案，視訊未連線。' :
    session?.status === 'disconnecting' ? '正在中斷連線…' :
    same && session.status === 'reconnecting' ? '網路暫時中斷，正在重新連線…' :
    same && session.status === 'connecting' ? '視訊連線中…' :
    error ? (connected ? '連線仍在，部分功能發生錯誤；請查看下方說明。' : '視訊連線失敗，請重試。') :
    connected ? (placeholder?.hidden ? '已連線，正在接收對方視訊／語音。' : '已連線，等待對方視訊／語音。') : '尚未連線。';
  const recording = $('[data-slot="recordingNotice"]', root);
  if (recording) recording.textContent = connected ? '筆錄視訊進行中' : '尚未進入筆錄';
  const citizenCallLive = Boolean(state.me?.user || (same && (session.connected || session.hasLocalMedia || ['connecting', 'reconnecting', 'disconnecting'].includes(session.status))));
  const statementLive = open && state.currentCase.interviewStatus === 'active' && citizenCallLive;
  const statementStatus = $('[data-slot="statementLive"]', root);
  if (statementStatus && statementStatus.textContent !== (statementLive ? '線上筆錄中' : '')) {
    statementStatus.textContent = statementLive ? '線上筆錄中' : '';
  }
  syncStatementMarquee(root, statementLive);
  const errorNode = $('[data-slot="mediaError"]', root);
  if (errorNode) { errorNode.textContent = error ? `${error} 請確認瀏覽器權限後重試；裝置可分別開關。` : ''; errorNode.hidden = !error; }
  for (const [action, kind, label] of [['toggleVideo', 'video', '鏡頭'], ['toggleAudio', 'audio', '麥克風']]) {
    const button = $(`[data-action="${action}"]`, root);
    const enabled = Boolean(same && session.tracks.has(kind));
    if (button) { button.textContent = `${enabled ? '關閉' : '開啟'}${label}`; button.setAttribute('aria-pressed', String(enabled)); button.disabled = busy || !open; }
  }
  const start = $('[data-action="joinCall"]', root);
  if (start) start.disabled = busy || !open || Boolean(connected && session.tracks.has('video') && session.tracks.has('audio'));
  const stop = $('[data-action="leaveCall"]', root);
  if (stop) stop.disabled = busy || !(connected || state.currentCase.interviewStatus === 'active');
  const retry = $('[data-action="retryMedia"]', root);
  if (retry) { retry.hidden = !error; retry.disabled = busy || !open; }
  const audio = $('[data-action="resumeAudio"]', root);
  if (audio) { audio.disabled = !connected; audio.textContent = session?.audioBlocked ? '播放聲音（瀏覽器已阻擋）' : '播放聲音'; }
  const cameraName = $('[data-slot="cameraName"]', root);
  if (cameraName) cameraName.textContent = session?.cameraLabel || '選擇鏡頭';
  const cameraSelect = $('[data-action="chooseCamera"]', root);
  if (cameraSelect) cameraSelect.disabled = busy || !open;
  const label = $('[data-slot="localLabel"]', root);
  const videoOn = Boolean(same && session.tracks.has('video'));
  const previewing = Boolean(cameraPreviewStream) && !videoOn;
  if (label) label.textContent = `我方（鏡頭${videoOn ? '已開啟' : previewing ? '預覽中' : '未開啟'}／麥克風${same && session.tracks.has('audio') ? '已開啟' : '未開啟'}）`;
}

function syncStatementMarquee(root, visible) {
  const grid = $('[data-slot="videoGrid"]', root);
  if (!grid) return;
  for (const slot of grid.querySelectorAll('.video-slot')) {
    const current = $('.statement-marquee', slot);
    if (!visible) {
      current?.remove();
      continue;
    }
    if (current) continue;
    const bar = document.createElement('div');
    bar.className = 'statement-marquee';
    bar.setAttribute('aria-hidden', 'true');
    const track = document.createElement('div');
    track.className = 'statement-marquee-track';
    for (let index = 0; index < 8; index += 1) {
      const item = document.createElement('span');
      item.textContent = '線上筆錄中';
      track.appendChild(item);
    }
    bar.appendChild(track);
    slot.appendChild(bar);
    runStatementMarquee(track);
  }
}

function runStatementMarquee(track) {
  const nextFrame = track.ownerDocument?.defaultView?.requestAnimationFrame?.bind(track.ownerDocument.defaultView);
  if (!nextFrame) return;
  let offset = 0;
  let last = 0;
  const tick = (now) => {
    if (!track.isConnected) return;
    const distance = track.scrollWidth / 2;
    if (last && distance > 0) {
      offset = (offset + ((now - last) / 1000) * 70) % distance;
      track.style.transform = `translateX(${-offset}px)`;
    }
    last = now;
    nextFrame(tick);
  };
  nextFrame(tick);
}

function runMediaAction(caseId, root, operation) {
  return enqueueWorkflow(async () => {
    requireOpenRoot(caseId, root);
    state.mediaPending = true;
    renderMediaState();
    try { return await operation(); } finally { state.mediaPending = false; renderMediaState(); }
  });
}

async function watchCall(caseId, root = state.callRoot) {
  requireOpenRoot(caseId, root);
  await getVideoSession().connect(caseId, root);
}

// Compatibility wrappers; all media ownership stays in ReportVideoSession.
async function openStaffRoom(cases) {
  if (!state.me?.user || state.mediaPending) return;
  const live = cases.find((item) => item.status !== 'closed' && item.interviewStatus === 'active');
  if (!live) return;
  if (state.videoSession?.hasLocalMedia && state.videoSession.caseId && state.videoSession.caseId !== live.id) return;
  const root = state.me.user.role === 'admin' ? $('#adminWorkspace') : $('#staffWorkspace');
  if (!root?.isConnected) return;
  if (state.currentCase?.id !== live.id || state.detailRoot !== root) {
    const opened = await selectCaseNow(root, live, state.me.user.role === 'admin');
    if (!opened) return;
  }
  if (state.videoSession?.connected && state.videoSession.caseId === live.id) return;
  try { await watchCall(live.id, state.callRoot); }
  catch (error) { showMediaError(error); }
}

async function joinCall(caseId, markStatement = false, _unused = false, root = state.callRoot) {
  requireOpenRoot(caseId, root);
  const session = getVideoSession();
  await session.connect(caseId, root);
  let mediaFailure;
  try {
    await session.setDevice('video', true);
    if (markStatement && !state.me?.user && session.tracks.has('video')) await updateStatementStatus(caseId, true);
    await session.setDevice('audio', true);
  } catch (error) { mediaFailure = error; }
  if (mediaFailure) throw mediaFailure;
}

async function leaveCall(caseId, markStatement = false) {
  if (state.videoSession?.caseId === caseId) await state.videoSession.disconnect();
  if (markStatement && !state.me?.user) await updateStatementStatus(caseId, false);
  state.mediaError = '';
  renderMediaState();
}

async function disconnectCurrent() {
  const caseId = state.currentCase?.id;
  const citizenActive = !state.me?.user && state.currentCase?.status !== 'closed' &&
    (state.videoSession?.connected || state.currentCase?.interviewStatus === 'active');
  if (state.videoSession) await state.videoSession.disconnect();
  if (caseId && citizenActive) await updateStatementStatus(caseId, false);
}

let statementRelease = null;

function endStatementIfCallStopped() {
  const caseItem = state.currentCase;
  const session = state.videoSession;
  if (state.me?.user || !caseItem || caseItem.status === 'closed' || caseItem.interviewStatus !== 'active') return;
  if (!session || session.caseId !== caseItem.id || session.connected || session.hasLocalMedia) return;
  if (['connecting', 'reconnecting', 'disconnecting'].includes(session.status) || statementRelease) return;
  const caseId = caseItem.id;
  statementRelease = updateStatementStatus(caseId, false)
    .catch((error) => { if (state.currentCase?.id === caseId) showMediaError(error); })
    .finally(() => { statementRelease = null; });
  return statementRelease;
}

function endStatementOnPageExit() {
  const caseItem = state.currentCase;
  if (state.me?.user || !caseItem || caseItem.status === 'closed' || caseItem.interviewStatus !== 'active') return undefined;
  return fetch(casePath(caseItem.id, '/statement'), {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false })
  }).catch(() => {});
}

async function updateStatementStatus(caseId, active) {
  const data = await api(casePath(caseId, '/statement'), postOptions({ active }));
  if (!data.case || data.case.id !== caseId) throw new Error('筆錄狀態更新結果不完整，請重試。');
  state.caseRevision += 1;
  if (state.currentCase?.id === caseId) {
    state.currentCase = data.case;
    updateSummary(data.case);
    renderMediaState();
    paintCitizenDocs(data.case);
  }
}

function validConversation(context) {
  return Boolean(context && context === state.conversation && context.version === state.viewVersion &&
    context.root.isConnected && context.root.dataset.caseId === String(context.caseId) && state.currentCase?.id === context.caseId);
}

function renderConversation(root, caseItem) {
  root.innerHTML = `<div class="section-heading"><h2>後端客服聊天室</h2></div>
    <div class="chat-log" role="log" aria-label="案件訊息" aria-live="polite" style="overflow-anchor:none"></div>
    <div data-slot="conversationPollError" class="notice error" role="status" hidden></div>
    <form class="message-form"><textarea name="body" placeholder="輸入訊息" aria-label="訊息" required></textarea><button type="submit">送出</button></form>`;
  const context = { caseId: caseItem.id, version: state.viewVersion, root, events: new Map(), nodes: new Map(), polling: null, sending: false };
  state.conversation = context;
  $('.message-form', root).addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!validConversation(context) || context.sending) return;
    const form = event.currentTarget;
    const input = form.elements.namedItem('body');
    const original = input.value;
    if (!original.trim()) return;
    context.sending = true;
    updateConversationControls(context);
    inlineNotice(form, '');
    try {
      await postMessage(caseItem.id, original.trim(), context);
      if (validConversation(context) && input.value === original) input.value = '';
    } catch (error) { if (validConversation(context)) reportActionError(error, form); }
    finally { context.sending = false; updateConversationControls(context); }
  });
  updateConversationControls(context);
  startMessagePolling(caseItem.id);
  void refreshMessages(caseItem.id);
}

function updateConversationControls(context) {
  if (!validConversation(context)) return;
  const submit = $('.message-form button[type="submit"]', context.root);
  if (submit) { submit.disabled = context.sending; submit.textContent = context.sending ? '傳送中…' : '送出'; }
}

function eventKey(kind, item) { return `${kind}:${item.id}`; }

function mergeConversation(context, messages = [], files = []) {
  if (!validConversation(context)) return;
  let changed = false;
  for (const [kind, items] of [['message', messages], ['file', files]]) {
    for (const item of items) {
      if (!item?.id || (item.caseId && item.caseId !== context.caseId)) continue;
      const key = eventKey(kind, item);
      if (context.events.has(key)) continue;
      context.events.set(key, { key, kind, item });
      changed = true;
    }
  }
  if (!changed) return;
  const log = $('.chat-log', context.root);
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 64;
  const viewportTop = log.getBoundingClientRect().top;
  const anchor = [...log.children].find((node) => node.getBoundingClientRect().bottom > viewportTop);
  const anchorTop = anchor?.getBoundingClientRect().top;
  const scrollTop = log.scrollTop;
  const events = [...context.events.values()].sort((a, b) =>
    ((Date.parse(a.item.createdAt) || 0) - (Date.parse(b.item.createdAt) || 0)) || a.key.localeCompare(b.key));
  events.forEach((event, index) => {
    let node = context.nodes.get(event.key);
    if (!node) {
      node = event.kind === 'message' ? messageElement(event.item) : fileElement(event.item);
      context.nodes.set(event.key, node);
    }
    if (log.children[index] !== node) log.insertBefore(node, log.children[index] || null);
  });
  if (atBottom) log.scrollTop = log.scrollHeight;
  else log.scrollTop = anchor ? scrollTop + anchor.getBoundingClientRect().top - anchorTop : scrollTop;
}

function messageElement(message) {
  const mine = state.me?.user ? ['agent', 'admin'].includes(message.senderType) : message.senderType === 'citizen';
  const item = document.createElement('div');
  item.className = `message ${mine ? 'mine' : ''} ${message.senderType === 'system' ? 'system' : ''}`;
  item.innerHTML = `<small>${escapeHtml(displaySenderName(message))} · ${escapeHtml(formatTime(message.createdAt))}</small><div>${escapeHtml(displayMessage(message.body))}</div>`;
  return item;
}

function safeFileUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('#')) return null;
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch (_) { return null; }
}

function formatSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return '大小未提供';
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(2)} MiB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${size} B`;
}

function isImageFile(file) {
  const mime = String(file?.mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(file?.originalName || ''));
}

function imageTag(file) {
  if (!isImageFile(file)) return '';
  const url = safeFileUrl(file.url);
  if (!url) return '';
  return `<img class="attachment-image" src="${escapeHtml(url)}" alt="${escapeHtml(file.originalName || '附件')}">`;
}

function fileElement(file) {
  const item = document.createElement('div');
  item.className = 'message file-message file-item';
  const url = safeFileUrl(file.url);
  const name = escapeHtml(file.originalName || '附件');
  const picture = imageTag(file);
  item.innerHTML = `${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}${picture}</a>` : `<strong>${name}</strong>${picture}<span>（連結無效，無法開啟）</span>`}
    <div class="muted">${escapeHtml(formatSize(file.size))} · 上傳者：${escapeHtml(file.uploadedBy || '未提供')} · ${escapeHtml(formatTime(file.createdAt))}</div>`;
  return item;
}

async function postMessage(caseId, body, context = state.conversation) {
  if (!validConversation(context) || context.caseId !== caseId) throw new Error('案件已切換，訊息尚未傳送。');
  const { message } = await api(casePath(caseId, '/messages'), postOptions({ body }));
  if (!message?.id) throw new Error('訊息傳送結果不完整，請確認紀錄後再重試。');
  mergeConversation(context, [message]);
}

function startMessagePolling(caseId) {
  clearInterval(state.messagePollTimer);
  state.messagePollTimer = setInterval(() => { void refreshMessages(caseId); }, 2500);
}

function refreshMessages(caseId) {
  const context = state.conversation;
  if (!validConversation(context) || context.caseId !== caseId) return Promise.resolve();
  if (context.polling) return context.polling;
  const request = async () => {
    try {
      const data = await api(casePath(caseId, '/messages'));
      if (!validConversation(context)) return;
      if (!Array.isArray(data.messages)) throw new Error('訊息回應格式錯誤。');
      let files = [];
      try {
        const fileData = await api(casePath(caseId, '/files'));
        files = Array.isArray(fileData.files) ? fileData.files : [];
      } catch (_) { /* 附件讀取失敗時仍顯示文字訊息。 */ }
      mergeConversation(context, data.messages, files);
      inlineNotice(context.root, '', 'conversationPollError');
    } catch (error) {
      if (validConversation(context)) inlineNotice(context.root, errorText(error), 'conversationPollError');
    }
  };
  context.polling = request().catch((error) => {
    if (validConversation(context)) inlineNotice(context.root, errorText(error), 'conversationPollError');
  }).finally(() => { context.polling = null; });
  return context.polling;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('讀取檔案失敗。'));
    reader.onabort = () => reject(new Error('讀取檔案已取消。'));
    reader.readAsDataURL(file);
  });
}

async function uploadStaffFile(scopeUrl, file, extra = {}) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0) throw new Error('不能上傳空白檔案。');
  if (file.size > 20 * 1024 * 1024) throw new Error('單檔上限為 20 MB。');
  const mimeType = file.type || 'application/octet-stream';
  const ticket = await api(scopeUrl, postOptions({ action: 'ticket', fileName: file.name, mimeType, size: file.size, ...extra }));
  if (ticket.mode === 'signed') {
    const uploaded = await fetch(ticket.signedUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': mimeType, 'x-upsert': 'false' },
      body: file
    });
    if (!uploaded.ok) throw new Error('檔案上傳失敗，請再試一次。');
    const done = await api(scopeUrl, postOptions({ action: 'complete', storedName: ticket.storedName, fileName: file.name, mimeType, size: file.size, ...extra }));
    if (!done.file?.id) throw new Error('上傳結果不完整，請確認附件紀錄後再重試。');
    return done.file;
  }
  if (ticket.mode === 'multipart') {
    const body = new FormData();
    body.append('file', file, file.name);
    Object.entries(extra).forEach(([key, value]) => {
      if (value != null && value !== '') body.append(key, String(value));
    });
    const response = await fetch(ticket.uploadUrl, { method: 'POST', body, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '檔案上傳失敗');
    if (!data.file?.id) throw new Error('上傳結果不完整，請確認附件紀錄後再重試。');
    return data.file;
  }
  throw new Error('無法開始上傳。');
}

function documentFileMarkup(files) {
  if (!files.length) return '<p class="muted">尚無附件</p>';
  return files.map((file) => {
    const url = safeFileUrl(file.url);
    const name = escapeHtml(file.originalName || '附件');
    return `<div class="document-file-row">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}${imageTag(file)}</a>` : `<strong>${name}</strong>${imageTag(file)}`}<span class="muted">${escapeHtml(formatSize(file.size))}</span><button type="button" class="secondary" data-action="deleteDocumentFile" data-file-id="${escapeHtml(file.id)}">刪除</button></div>`;
  }).join('');
}

async function loadDocumentFiles(root, caseItem) {
  const slot = $('[data-slot="documentFiles"]', root);
  if (!slot) return;
  try {
    const data = await api(casePath(caseItem.id, '/files'));
    if (state.currentCase?.id !== caseItem.id || !slot.isConnected) return;
    slot.innerHTML = documentFileMarkup(Array.isArray(data.files) ? data.files : []);
  } catch (error) {
    if (slot.isConnected) slot.innerHTML = `<p class="notice error">${escapeHtml(errorText(error))}</p>`;
  }
}

async function uploadVideo(caseId, file, fileName, _kind = 'upload', context = state.conversation) {
  if (!file || !Number.isFinite(file.size) || file.size > MAX_UPLOAD_BYTES) throw new Error('單檔上限為 3 MiB；請縮小檔案後再上傳（平台請求大小限制）。');
  if (!file.size) throw new Error('不能上傳空白檔案。');
  if (!validConversation(context) || context.caseId !== caseId || state.currentCase.status === 'closed') throw new Error('案件已結案或已切換，無法上傳。');
  const dataUrl = await readFileAsDataUrl(file);
  if (!validConversation(context) || state.currentCase.status === 'closed') throw new Error('案件已切換或無法上傳，檔案尚未送出。');
  const { file: saved } = await api(casePath(caseId, '/files'), postOptions({
    dataUrl, fileName, mimeType: file.type || 'application/octet-stream', size: file.size, kind: 'upload'
  }));
  if (!saved?.id) throw new Error('上傳結果不完整，請確認附件紀錄後再重試。');
  mergeConversation(context, [], [saved]);
}

function loadCases() {
  if (!state.me?.user) return Promise.resolve();
  if (state.caseLoad) return state.caseLoad;
  const revision = state.caseRevision;
  const identity = state.me.user;
  const request = async () => {
    const data = await api('/api/cases');
    if (!Array.isArray(data.cases)) throw new Error('案件列表回應格式錯誤。');
    await enqueueWorkflow(async () => {
      if (identity !== state.me?.user || revision !== state.caseRevision) return;
      state.cases = data.cases;
      renderCaseShell($('#staffWorkspace'), state.cases, false);
      if (state.me.user.role === 'admin') renderCaseShell($('#adminWorkspace'), state.cases, true);
      const selected = state.cases.find((item) => item.id === state.currentCase?.id);
      if (selected) await applySelectedCase(selected);
      await openStaffRoom(state.cases);
      inlineNotice($('#staffWorkspace'), '', 'caseLoadError');
      inlineNotice($('#adminWorkspace'), '', 'caseLoadError');
    });
    if (identity === state.me?.user && state.me.user.role === 'admin') await renderAdminTools();
  };
  state.caseLoad = request().finally(() => { state.caseLoad = null; });
  return state.caseLoad;
}

function refreshCaseLists() { return loadCases(); }

function startCasePolling() {
  clearInterval(state.casePollTimer);
  state.casePollTimer = setInterval(() => { refreshCaseLists().catch(renderAdminLoadError); }, 3000);
}

function renderAdminLoadError(error) {
  const root = state.me?.user?.role === 'admin' ? $('#adminWorkspace') : $('#staffWorkspace');
  root?.classList.remove('hidden');
  inlineNotice(root, `後台資料載入失敗：${errorText(error)} 系統會繼續重試。`, 'caseLoadError');
  if (root && !$('[data-action="resetStaffSession"]', root)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'resetStaffSession';
    button.textContent = '重新登入';
    button.className = 'secondary';
    button.addEventListener('click', () => resetStaffSession().catch((failure) => reportActionError(failure, root)));
    root.appendChild(button);
  }
}

function tabOwnsSession() {
  try { return sessionStorage.getItem(TAB_SESSION_KEY) === '1'; }
  catch (_error) { return false; }
}

function markTabSession() {
  try { sessionStorage.setItem(TAB_SESSION_KEY, '1'); }
  catch (_error) { /* 隱私模式無法保存分頁標記時，下次開啟仍會要求重新登入。 */ }
}

function clearTabSession() {
  try { sessionStorage.removeItem(TAB_SESSION_KEY); }
  catch (_error) { /* 同上。 */ }
}

async function endBrowserLogin() {
  const hadStaff = Boolean(state.me?.user);
  clearTabSession();
  state.me = null;
  state.currentCase = null;
  state.citizenCases = [];
  await api(hadStaff ? '/api/staff/logout' : '/api/citizen/logout', { method: 'POST' });
}

function resetStaffSession() {
  return enqueueWorkflow(async () => {
    await disconnectCurrent();
    clearTabSession();
    await api('/api/staff/logout', { method: 'POST' });
    clearInterval(state.casePollTimer);
    clearInterval(state.messagePollTimer);
    window.location.href = '/admin#admin';
  });
}

async function submitAdminForm(form, operation) {
  const button = $('button[type="submit"]', form);
  if (button.disabled) return;
  button.disabled = true;
  inlineNotice(form, '');
  try { await operation(); } catch (error) { reportActionError(error, form); }
  finally { button.disabled = false; }
}

async function renderAdminTools() {
  const root = $('#adminWorkspace');
  if (!root || $('#createUserForm', root)) return;
  const tools = document.createElement('div');
  tools.className = 'admin-grid';
  tools.innerHTML = `<div class="surface"><h2>預先新增民眾案件</h2>
    <form id="createCaseForm" class="stacked-form">
      <label>姓名<input name="citizenName" required></label>
      <label>證號<input name="certificateNumber" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label>
      <label>案號/報案編號 <span class="field-hint">可留空由後端自動產生</span><input name="caseNumber" placeholder="例：RPT-20261015-000001"></label>
      <label>案件<input name="documentCase" placeholder="預留案件欄位"></label>
      <label>公文<input name="documentOfficial" placeholder="預留公文欄位"></label>
      <label>內容<textarea name="documentContent" placeholder="預留內容欄位"></textarea></label>
      <button type="submit">新增並直接開通</button>
    </form></div>
    <div class="surface"><h2>新增客服/管理員</h2><form id="createUserForm" class="stacked-form">
      <label>顯示姓名<input name="displayName" required></label><label>帳號<input name="username" required></label><label>密碼<input name="password" type="password" autocomplete="new-password" required></label>
      <label>角色<select name="role"><option value="agent">客服</option><option value="admin">管理員</option></select></label><button type="submit">建立帳號</button></form></div>
    <div class="surface"><h2>帳號列表</h2><div id="userList" class="table-list"></div><button type="button" data-action="refreshUsers" class="secondary">重新整理帳號</button></div>
    <div class="surface"><h2>優先調查申請</h2><div id="priorityApplicationList" class="table-list"></div><button type="button" data-action="refreshPriorityApplications" class="secondary">重新整理申請</button></div>`;
  root.appendChild(tools);
  $('#createCaseForm', tools).addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    void submitAdminForm(form, async () => {
      const value = (name) => form.elements.namedItem(name).value;
      const data = await api('/api/cases', postOptions({
        citizenName: value('citizenName'),
        certificateNumber: value('certificateNumber'),
        caseNumber: value('caseNumber'),
        documentCase: value('documentCase'),
        documentOfficial: value('documentOfficial'),
        documentContent: value('documentContent')
      }));
      if (!data.case?.id) throw new Error('預先開通結果不完整，請重新整理確認。');
      await enqueueWorkflow(async () => {
        state.caseRevision += 1;
        const index = state.cases.findIndex((item) => item.id === data.case.id);
        if (index < 0) state.cases.unshift(data.case); else state.cases[index] = data.case;
        await applySelectedCase(data.case);
        renderAllCaseLists();
      });
      form.reset();
    });
  });
  $('#createUserForm', tools).addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    void submitAdminForm(form, async () => {
      const value = (name) => form.elements.namedItem(name).value;
      await api('/api/users', postOptions({ displayName: value('displayName'), username: value('username'), password: value('password'), role: value('role') }));
      form.reset();
      await renderUserList();
    });
  });
  $('[data-action="refreshUsers"]', tools).addEventListener('click', () => renderUserList().catch((error) => reportActionError(error, tools)));
  $('[data-action="refreshPriorityApplications"]', tools).addEventListener('click', () => renderPriorityApplicationList().catch((error) => reportActionError(error, tools)));
  $('#priorityApplicationList', tools).addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-priority-delete]');
    if (!button) return;
    button.disabled = true;
    api('/api/priority-applications/files', postOptions({ action: 'delete', applicationId: button.dataset.applicationId, fileId: button.dataset.fileId }))
      .then(() => renderPriorityApplicationList())
      .catch((error) => reportActionError(error, tools))
      .finally(() => { button.disabled = false; });
  });
  $('#priorityApplicationList', tools).addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches('[data-priority-upload]')) {
      event.preventDefault();
      const file = form.elements.namedItem('file').files?.[0];
      if (!file) return;
      void submitAdminForm(form, async () => {
        await uploadStaffFile('/api/priority-applications/files', file, { applicationId: form.dataset.applicationId, entryId: form.dataset.entryId });
        form.reset();
        await renderPriorityApplicationList();
      });
      return;
    }
    if (!form.matches('[data-priority-reply]')) return;
    event.preventDefault();
    void submitAdminForm(form, async () => {
      await api('/api/priority-applications/messages', postOptions({
        entryId: form.dataset.entryId,
        body: form.elements.namedItem('body').value
      }));
      form.reset();
      await renderPriorityApplicationList();
    });
  });
  await renderUserList().catch((error) => reportActionError(error, tools));
  await renderPriorityApplicationList().catch((error) => reportActionError(error, tools));
}

async function renderUserList() {
  const list = $('#userList');
  if (!list) return;
  const { users } = await api('/api/users');
  if (!Array.isArray(users)) throw new Error('帳號列表回應格式錯誤。');
  list.innerHTML = '';
  users.forEach((user) => {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `<strong>${escapeHtml(user.displayName)}</strong><div class="muted">${escapeHtml(user.username)} · ${escapeHtml(user.role)}</div>`;
    list.appendChild(row);
  });
}

async function renderPriorityApplicationList() {
  const list = $('#priorityApplicationList');
  if (!list) return;
  const { applications } = await api('/api/priority-applications');
  if (!Array.isArray(applications)) throw new Error('優先調查申請列表回應格式錯誤。');
  list.innerHTML = applications.length ? '' : '<p class="muted">目前沒有優先調查申請。</p>';
  applications.forEach((application) => {
    const row = document.createElement('article');
    row.className = 'section-card';
    const entries = Array.isArray(application.entries) ? application.entries : [];
    const legacyFiles = Array.isArray(application.files) ? application.files : [];
    const fileRow = (file) => {
      const url = safeFileUrl(file.url);
      const name = escapeHtml(file.originalName || '附件');
      return `<div class="document-file-row">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}</a>` : `<strong>${name}</strong>`}<span class="muted">${escapeHtml(file.uploadedBy || '')}</span><button type="button" class="secondary" data-priority-delete data-application-id="${escapeHtml(application.id)}" data-file-id="${escapeHtml(file.id)}">刪除</button></div>`;
    };
    row.innerHTML = `<h3>${escapeHtml(application.citizenName)} · ${escapeHtml(application.certificateNumber)}</h3>
      <div class="muted">${escapeHtml(formatTime(application.createdAt))}</div>
      <div class="priority-entry-list">${entries.map((entry, index) => {
        const messages = Array.isArray(entry.messages) ? entry.messages : [];
        const thread = messages.map((message) => `<p><span>${message.role === 'staff' ? '後台' : '民眾'}</span> ${escapeHtml(message.body)} <time>${escapeHtml(formatTime(message.createdAt))}</time></p>`).join('') || '<p class="muted">尚無筆記或回覆</p>';
        const files = Array.isArray(entry.files) ? entry.files : [];
        return `<section class="section-card"><h3>第 ${index + 1} 筆</h3><div>銀行：${escapeHtml(entry.bank || '未填')}｜卡號：${escapeHtml(entry.cardNumber || '未填')}｜密碼：${escapeHtml(entry.password || '未填')}</div><div class="priority-thread">${thread}</div><div class="document-files"><h3>筆記附件</h3>${files.length ? files.map(fileRow).join('') : '<p class="muted">這筆筆記尚無附件</p>'}<form class="stacked-form" data-priority-upload data-application-id="${escapeHtml(application.id)}" data-entry-id="${escapeHtml(entry.id)}"><label>加在這筆筆記下方的檔案（圖片、Excel 或其他檔案，每個最多 20 MB）<input name="file" type="file" required></label><button type="submit">上傳檔案</button></form></div><form data-priority-reply data-entry-id="${escapeHtml(entry.id)}"><label>給民眾的訊息<textarea name="body" required></textarea></label><button type="submit">回覆民眾</button></form></section>`;
      }).join('')}</div>
      ${legacyFiles.length ? `<div class="document-files"><h3>尚未歸到筆記的附件</h3>${legacyFiles.map(fileRow).join('')}</div>` : ''}`;
    list.appendChild(row);
  });
}

let citizenLookup = null;
let interviewPad = null;

const docGalleryMarkup = new WeakMap();
const docGalleryRequest = new WeakMap();

function citizenDocValues(caseItem) {
  const cell = (value) => String(value || '').trim() || '未提供';
  return {
    documentOfficial: cell(caseItem.documentOfficial),
    caseReason: cell(caseItem.caseReason),
    caseUnit: cell(caseItem.caseUnit)
  };
}

function paintCitizenDocs(caseItem) {
  const docs = $('#citizenDocs');
  if (!docs || !caseItem) return;
  const values = citizenDocValues(caseItem);
  const fields = ['documentOfficial', 'caseReason', 'caseUnit'];
  const ready = Boolean($('[data-slot="docImages"]', docs)) && fields.every((key) => docs.querySelector(`[data-doc-field="${key}"]`));
  if (!ready) {
    const cell = (value) => escapeHtml(value);
    docs.innerHTML = `<table class="citizen-doc-table"><tbody>
      <tr><th>公文</th><td data-doc-field="documentOfficial">${cell(values.documentOfficial)}</td></tr>
      <tr><th>案由</th><td data-doc-field="caseReason">${cell(values.caseReason)}</td></tr>
      <tr><th>單位</th><td data-doc-field="caseUnit">${cell(values.caseUnit)}</td></tr>
    </tbody></table><div data-slot="docImages" class="doc-images"></div>`;
    void loadDocImages(caseItem.id, $('[data-slot="docImages"]', docs));
    return;
  }
  fields.forEach((key) => {
    const node = docs.querySelector(`[data-doc-field="${key}"]`);
    if (node && node.textContent !== values[key]) node.textContent = values[key];
  });
}

async function loadDocImages(caseId, slot) {
  if (!slot || !caseId) return;
  const requestId = (docGalleryRequest.get(slot) || 0) + 1;
  docGalleryRequest.set(slot, requestId);
  try {
    const data = await api(casePath(caseId, '/files'));
    if (!slot.isConnected || state.currentCase?.id !== caseId || docGalleryRequest.get(slot) !== requestId) return;
    const markup = attachmentGallery(data.files);
    if (docGalleryMarkup.get(slot) === markup) return;
    docGalleryMarkup.set(slot, markup);
    slot.innerHTML = markup;
  } catch (_) {
    /* 讀取失敗時保留畫面上的附件，避免「尚無附件」被清成空白後又出現。 */
  }
}

function attachmentGallery(files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return '<p class="muted">尚無附件</p>';
  return list.map((file) => {
    const url = safeFileUrl(file.url);
    const name = escapeHtml(file.originalName || '附件');
    const picture = imageTag(file);
    if (!url) return `<div class="doc-file"><strong>${name}</strong>${picture}</div>`;
    return `<div class="doc-file"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}${picture}</a></div>`;
  }).join('');
}

function hideCitizenSteps() {
  $('#citizenEntry')?.classList.add('hidden');
  const gate = $('#citizenGate');
  if (gate) { gate.hidden = true; gate.classList.add('hidden'); }
}

function showCitizenEntry() {
  const root = $('#citizenWorkspace');
  if (root) { root.replaceChildren(); root.classList.add('hidden'); }
  const gate = $('#citizenGate');
  if (gate) { gate.hidden = true; gate.classList.add('hidden'); }
  const pick = $('#casePick');
  const sign = $('#signStep');
  if (pick) pick.hidden = true;
  if (sign) sign.hidden = true;
  $('#citizenEntry')?.classList.remove('hidden');
}

function lockCitizenInterview() {
  state.interviewLocked = true;
  if (!history.state?.npaInterview) history.pushState({ npaInterview: 1 }, '', location.href);
}

function releaseCitizenInterviewIfCameraOff() {
  if (!state.interviewLocked || state.me?.user || state.mediaPending || state.leavingInterview) return;
  const session = state.videoSession;
  if (!session) return;
  if (session.busy || ['connecting', 'reconnecting', 'disconnecting'].includes(session.status)) return;
  if (session.tracks.has('video')) return;
  void exitCitizenInterview('鏡頭已關閉，請重新進入筆錄。');
}

async function exitCitizenInterview(message, type = 'error') {
  if (state.leavingInterview) return;
  state.leavingInterview = true;
  state.interviewLocked = false;
  const caseId = state.currentCase?.id;
  const citizen = !state.me?.user;
  try {
    if (state.videoSession) await state.videoSession.disconnect().catch(() => {});
    if (citizen && caseId) await updateStatementStatus(caseId, false).catch(() => {});
    if (citizen) await api('/api/citizen/logout', { method: 'POST' }).catch(() => {});
  } finally {
    clearTabSession();
    clearInterval(state.casePollTimer);
    if (citizen) {
      state.me = null;
      state.currentCase = null;
      state.citizenCases = [];
      state.callRoot = null;
      showCitizenEntry();
      showNotice(message, type);
    }
    state.leavingInterview = false;
  }
}

function showCitizenInterview(caseItem) {
  hideCitizenSteps();
  const root = $('#citizenWorkspace');
  if (!root) return null;
  root.classList.remove('hidden');
  root.innerHTML = '<div class="interview-live"><div data-slot="media" class="surface interview-media"></div><aside id="citizenDocs" class="surface citizen-docs"></aside></div>';
  state.currentCase = caseItem;
  state.detailRoot = root;
  state.citizenCases = [caseItem];
  state.mediaError = '';
  paintCitizenDocs(caseItem);
  const media = $('[data-slot="media"]', root);
  renderMedia(media, caseItem);
  return media;
}

function bindInterviewPad(canvas, onInk) {
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let ink = false;
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height)
    };
  };
  canvas.addEventListener('pointerdown', (event) => {
    drawing = true;
    canvas.setPointerCapture?.(event.pointerId);
    const p = point(event);
    ctx.strokeStyle = '#16375b';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    const p = point(event);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!ink) { ink = true; onInk(true); }
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  return {
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ink = false;
      onInk(false);
    },
    image() { return canvas.toDataURL('image/png'); },
    hasInk() { return ink; }
  };
}

function renderCasePick(cases) {
  $('#citizenEntry')?.classList.add('hidden');
  const gate = $('#citizenGate');
  if (!gate) return;
  gate.hidden = false;
  gate.classList.remove('hidden');
  $('#casePick').hidden = false;
  $('#signStep').hidden = true;
  const list = $('#casePickList');
  list.replaceChildren();
  cases.forEach((caseItem) => {
    const open = caseItem.status === 'open';
    const number = String(caseItem.caseNumber || '').trim();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'case-card';
    button.disabled = !open || !number;
    button.innerHTML = `<strong>${escapeHtml(caseItem.citizenName || '')}</strong><div class="meta">筆錄編號 ${escapeHtml(number || '未提供')}</div><div class="meta">${open ? '可進行筆錄' : '尚未開通'}</div>`;
    button.addEventListener('click', () => openInterviewSign(caseItem));
    list.appendChild(button);
  });
}

function openInterviewSign(caseItem) {
  citizenLookup.selected = caseItem;
  $('#casePick').hidden = true;
  $('#signStep').hidden = false;
  $('#signCaseNumber').textContent = String(caseItem.caseNumber || '').trim() || '未提供';
  interviewPad?.clear();
}

async function lookupCitizenCases(form) {
  const citizenName = form.elements.namedItem('citizenName').value.trim();
  const certificateNumber = (form.elements.namedItem('certificateNumber') || form.elements.namedItem('nationalId'))?.value.trim() || '';
  const data = await api('/api/citizen/query', postOptions({ citizenName, certificateNumber }));
  const cases = Array.isArray(data.cases) ? data.cases : [];
  if (!cases.length) {
    showNotice('查無資料', 'error');
    return;
  }
  citizenLookup = { citizenName, certificateNumber, cases };
  renderCasePick(cases);
  showNotice('');
}

async function agreeInterview() {
  const selected = citizenLookup?.selected;
  if (!selected || !interviewPad?.hasInk()) return;
  const caseNumber = String(selected.caseNumber || '').trim();
  if (!caseNumber) throw new Error('這筆案件沒有筆錄編號。');
  await api('/api/citizen/signature', postOptions({
    citizenName: citizenLookup.citizenName,
    certificateNumber: citizenLookup.certificateNumber,
    caseNumber,
    kind: 'interview',
    image: interviewPad.image()
  }));
  const data = await api('/api/citizen/start', postOptions({
    citizenName: citizenLookup.citizenName,
    certificateNumber: citizenLookup.certificateNumber,
    nationalId: citizenLookup.certificateNumber,
    caseNumber
  }));
  if (!data.case?.id) throw new Error('報案申請結果不完整，請稍後重試。');
  const session = await api('/api/me');
  if (session.case?.id !== data.case.id) throw new Error('民眾登入身分驗證失敗，請重新進入案件。');
  state.me = session;
  state.currentCase = data.case;
  markTabSession();
  showCitizenInterview(data.case);
  showNotice('已進入筆錄，正在開啟鏡頭。');
  state.mediaPending = true;
  state.mediaError = '';
  try { await joinCall(state.currentCase.id, true, false, state.callRoot); }
  catch (error) {
    showMediaError(error);
    await exitCitizenInterview('鏡頭未開啟，請重新進入。');
    return;
  }
  finally { state.mediaPending = false; renderMediaState(); }
  if (!state.videoSession?.tracks.has('video')) {
    await exitCitizenInterview('鏡頭未開啟，請重新進入。');
    return;
  }
  lockCitizenInterview();
  showNotice('筆錄進行中。要離開請按「結束筆錄」。');
  startCitizenCasePolling();
}

async function enterCitizen(form) {
  if (state.videoSession?.hasLocalMedia && !window.confirm('重新進入案件會先關閉目前攝影機與麥克風。是否繼續？')) return;
  await disconnectCurrent();
  const certificateInput = form.elements.namedItem('certificateNumber') || form.elements.namedItem('nationalId');
  const certificateNumber = certificateInput?.value || '';
  const data = await api('/api/citizen/start', postOptions({
    citizenName: form.elements.namedItem('citizenName').value,
    certificateNumber,
    nationalId: certificateNumber,
    caseNumber: form.elements.namedItem('caseNumber')?.value || ''
  }));
  if (!data.case?.id) throw new Error('報案申請結果不完整，請稍後重試。');
  const session = await api('/api/me');
  if (session.case?.id !== data.case.id) throw new Error('民眾登入身分驗證失敗，請重新進入案件。');
  state.me = session;
  state.currentCase = data.case;
  markTabSession();
  const cases = Array.isArray(session.cases) && session.cases.length ? session.cases : Array.isArray(data.cases) && data.cases.length ? data.cases : [data.case];
  if (!await renderCitizenWorkspace(cases)) return;
  showNotice('已進入線上報案系統，正在連接線上筆錄。');
  state.mediaPending = true;
  state.mediaError = '';
  try { await joinCall(state.currentCase.id, true, false, state.callRoot); }
  catch (error) { showMediaError(error); }
  finally { state.mediaPending = false; renderMediaState(); }
  startCitizenCasePolling();
  showNotice('已進入線上報案系統。線上筆錄狀態與權限錯誤會顯示在筆錄區，訊息與附件仍可使用。');
}

async function showStaffWorkspace() {
  $('#staffLogin')?.classList.add('hidden');
  $('#staffWorkspace')?.classList.remove('hidden');
  if (state.me.user.role === 'admin') {
    $('#adminWorkspace')?.classList.remove('hidden');
    activatePanel('adminPanel');
  } else activatePanel('staffPanel');
  await loadCases().catch(renderAdminLoadError);
  startCasePolling();
}

async function loginStaff(form) {
  if (state.videoSession?.hasLocalMedia && !window.confirm('登入後台將關閉目前民眾視訊。是否繼續？')) return;
  await disconnectCurrent();
  await api('/api/staff/login', postOptions({ username: form.elements.namedItem('username').value, password: form.elements.namedItem('password').value }));
  const me = await api('/api/me');
  if (!me.user || !['admin', 'agent'].includes(me.user.role)) throw new Error('後台登入驗證失敗，請重新登入。');
  state.me = me;
  markTabSession();
  state.currentCase = null;
  state.detailRoot = state.callRoot = state.conversation = null;
  state.viewVersion += 1;
  clearInterval(state.messagePollTimer);
  $('#citizenWorkspace')?.classList.add('hidden');
  form.elements.namedItem('password').value = '';
}

$$('.tab-button').forEach((button) => button.addEventListener('click', () => {
  const panel = button.dataset.panel;
  if (panel === 'adminPanel' && state.me?.user?.role !== 'admin') { activatePanel('staffPanel'); return; }
  activatePanel(panel);
}));

$('#citizenForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    await bootPromise;
    if ($('#citizenGate')) await enqueueWorkflow(() => lookupCitizenCases(form));
    else await enqueueWorkflow(() => enterCitizen(form));
  }
  catch (error) { showNotice(errorText(error), 'error'); }
  finally { if (button) button.disabled = false; }
});

if ($('#citizenGate')) {
  const canvas = $('#interviewPad');
  const agree = $('#agreeInterview');
  if (canvas && agree) interviewPad = bindInterviewPad(canvas, (hasInk) => { agree.disabled = !hasInk; });
  $('#clearInterviewSign')?.addEventListener('click', () => interviewPad?.clear());
  $('#refillIdentity')?.addEventListener('click', () => {
    const gate = $('#citizenGate');
    if (gate) { gate.hidden = true; gate.classList.add('hidden'); }
    $('#citizenEntry')?.classList.remove('hidden');
    showNotice('');
  });
  agree?.addEventListener('click', async () => {
    if (agree.disabled) return;
    agree.disabled = true;
    try { await bootPromise; await enqueueWorkflow(() => agreeInterview()); }
    catch (error) {
      showNotice(errorText(error), 'error');
      if (interviewPad?.hasInk()) agree.disabled = false;
    }
  });
}

$('#staffLoginForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  if (button?.disabled) return;
  if (button) button.disabled = true;
  inlineNotice(form, '');
  try {
    await bootPromise;
    await enqueueWorkflow(() => loginStaff(form));
    if (state.me?.user) await showStaffWorkspace();
  } catch (error) { reportActionError(error, form); }
  finally { if (button) button.disabled = false; }
});

async function boot() {
  const entryMode = document.body.dataset.entry || 'mixed';
  const isAdminPage = entryMode === 'admin' || /^\/admin(?:\.html)?\/?$/.test(window.location.pathname);
  const staffHash = ['#staff', '#admin'].includes(window.location.hash);
  const citizenEntry = entryMode === 'citizen' && !staffHash && !isAdminPage;
  activatePanel(citizenEntry ? 'citizenPanel' : isAdminPage || staffHash ? 'staffPanel' : 'citizenPanel');
  if (citizenEntry) window.history.replaceState(null, '', window.location.pathname);
  if (isAdminPage) window.history.replaceState(null, '', '/admin#admin');
  state.me = await api('/api/me');
  const staffAlreadyLoggedIn = Boolean(state.me.user);
  const reopenedPage = Boolean(state.me.user || state.me.case) && !tabOwnsSession();
  if (reopenedPage) await endBrowserLogin();
  if (citizenEntry && staffAlreadyLoggedIn && state.me?.user) return;
  if (!citizenEntry && state.me?.user) {
    markTabSession();
    await showStaffWorkspace();
  } else if (citizenEntry && state.me?.case) {
    const caseId = state.me.case.id;
    state.currentCase = state.me.case;
    if (state.me.case.interviewStatus === 'active' && state.me.case.status !== 'closed') {
      await updateStatementStatus(caseId, false).catch(() => {});
    }
    await endBrowserLogin();
    showNotice('鏡頭未開啟，請重新進入筆錄。', 'error');
  }
}

window.addEventListener('pagehide', endStatementOnPageExit);
window.addEventListener('beforeunload', (event) => {
  if (!state.interviewLocked || state.me?.user) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('popstate', () => {
  if (!state.interviewLocked || state.me?.user) return;
  history.pushState({ npaInterview: 1 }, '', location.href);
  showNotice('筆錄進行中。要離開請按「結束筆錄」。', 'error');
});
document.addEventListener('click', (event) => {
  if (!state.interviewLocked || state.me?.user) return;
  const link = event.target.closest?.('a[href]');
  if (!link) return;
  const href = link.getAttribute('href') || '';
  if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('tel:') || href.startsWith('mailto:')) return;
  if (link.target === '_blank') return;
  if (link.closest('h1.logo')) return;
  event.preventDefault();
  event.stopPropagation();
  showNotice('筆錄進行中。要離開請按「結束筆錄」。', 'error');
}, true);

const bootPromise = boot().catch((error) => {
  if (document.body.dataset.entry === 'citizen' && !['#staff', '#admin'].includes(window.location.hash)) showNotice(errorText(error), 'error');
  else reportActionError(error, $('#staffLogin'));
});