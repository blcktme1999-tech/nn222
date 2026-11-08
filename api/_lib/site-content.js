'use strict';

const NEWS_SEED = require('./site-news-seed.json');

const HOME_NEWS_LIMIT = 4;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_LENGTH = 20000;

const CATEGORIES = [
  { key: 'breaking', label: '破案快訊', tab: 'tab01', listPath: '/announcements/breaking-news.html' },
  { key: 'clarification', label: '即時新聞澄清', tab: 'tab02', listPath: '/announcements/clarifications.html' },
  { key: 'notice', label: '公告事項', tab: 'tab03', listPath: '/announcements/notices.html' },
  { key: 'crime', label: '最新犯罪手法', tab: 'tab04', listPath: '/announcements/crime-methods.html' }
];

const UNITS = [
  ['prevention-division', '預防科'],
  ['investigation-division', '偵查科'],
  ['anti-gang-division', '反黑科'],
  ['judicial-division', '司法科'],
  ['forensic-chemistry-division', '理化科'],
  ['fingerprint-division', '指紋科'],
  ['biology-division', '生物科'],
  ['records-division', '紀錄科'],
  ['international-criminal-police-division', '國際刑警科'],
  ['logistics-division', '後勤科'],
  ['secretariat', '秘書室'],
  ['inspection-training-division', '督訓科'],
  ['technology-research-division', '科技研發科'],
  ['criminal-information-division', '刑事資訊科'],
  ['public-relations-office', '公共關係室'],
  ['crime-investigation-command-center', '偵防犯罪指揮中心'],
  ['communications-surveillance-division', '通訊監察科'],
  ['personnel-office', '人事室'],
  ['accounting-office', '主計室'],
  ['investigation-brigades', '偵查第一至第九大隊、電信偵查大隊及智慧財產權偵查大隊'],
  ['fraud-prevention-center', '詐欺犯罪防制中心'],
  ['cross-strait-division', '兩岸科'],
  ['economic-crime-division', '經濟科'],
  ['ethics-office', '政風室'],
  ['narcotics-investigation-center', '毒品查緝中心'],
  ['cybercrime-prevention-center', '科技犯罪防制中心'],
  ['forensic-science-center', '刑事鑑識中心']
].map(([key, name]) => ({ key, name, path: `/agency/${key}.html` }));

const DEFAULT_CONTACT = {
  address: '110055 臺北市信義區忠孝東路四段553巷5號',
  mapUrl: '',
  servicePhone: '(02)27652122~5',
  reportPhones: ['(02)27661919', '(02)27668989']
};

const DEFAULT_FOOTER_QR = '/public/home-sections/footer-qr.png';
const DEFAULT_POSTERS = [
  { id: 'stalking', url: '/public/home-posters/stalking.jpg', sortOrder: 0 },
  { id: 'drunk-driving', url: '/public/home-posters/drunk-driving.jpg', sortOrder: 1 },
  { id: 'shelter', url: '/public/home-posters/shelter.jpg', sortOrder: 2 }
];

const MAX_POSTERS = 30;

function categoryKeys() {
  return CATEGORIES.map((item) => item.key);
}

function cleanText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanBody(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY_LENGTH);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validImageUrl(value) {
  const url = String(value || '').trim();
  if (url.startsWith('/uploads/site-news/') && !url.includes('..')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (_error) {
    return false;
  }
}

function normalizeContact(input = {}) {
  const reportPhones = Array.isArray(input.reportPhones) ? input.reportPhones : [input.reportPhonePrimary, input.reportPhoneSecondary];
  const contact = {
    address: cleanText(input.address, 200),
    mapUrl: String(input.mapUrl || '').trim().slice(0, 500),
    servicePhone: cleanText(input.servicePhone, 40),
    reportPhones: reportPhones.map((phone) => cleanText(phone, 40)).filter(Boolean).slice(0, 2)
  };
  if (contact.address.length < 4) return { error: '請輸入地址' };
  if (contact.servicePhone.length < 3) return { error: '請輸入服務電話' };
  if (!contact.reportPhones.length) return { error: '請輸入檢舉電話' };
  if (contact.mapUrl && !validImageUrl(contact.mapUrl)) return { error: '地圖連結須為 http 或 https 網址' };
  return { contact };
}

function normalizeUnits(input) {
  const byKey = new Map((Array.isArray(input) ? input : []).map((item) => [String(item.key || item.unitKey || ''), item]));
  const units = UNITS.map((unit) => {
    const email = String(byKey.get(unit.key)?.email || '').trim().toLowerCase();
    return { ...unit, email };
  });
  const invalid = units.find((unit) => unit.email && !validEmail(unit.email));
  if (invalid) return { error: `${invalid.name}的信箱格式不正確` };
  return { units };
}

function validFooterQr(value) {
  const url = String(value || '').trim();
  if (url === DEFAULT_FOOTER_QR) return true;
  if (url.startsWith('/uploads/site-footer/') && !url.includes('..') && !url.includes('\\')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (_error) {
    return false;
  }
}

function validPosterUrl(value) {
  const url = String(value || '').trim();
  if (DEFAULT_POSTERS.some((item) => item.url === url)) return true;
  if (url.startsWith('/uploads/site-posters/') && !url.includes('..') && !url.includes('\\')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (_error) {
    return false;
  }
}

function normalizePosters(input) {
  const source = Array.isArray(input) ? input : [];
  const urls = source.map((item) => String(item && typeof item === 'object' ? item.url : item || '').trim()).filter(Boolean);
  if (!urls.length) return { error: '至少要留一張橫幅' };
  if (urls.length > MAX_POSTERS) return { error: `橫幅最多 ${MAX_POSTERS} 張` };
  if (urls.some((url) => !validPosterUrl(url))) return { error: '圖片位址不正確' };
  return { posters: urls.map((url, index) => ({ url, sortOrder: index })) };
}

function publicPoster(row, index = 0) {
  return {
    id: String(row.id || `poster-${index}`),
    url: String(row.image_url || row.url || ''),
    sortOrder: Number(row.sort_order ?? row.sortOrder ?? index)
  };
}

function normalizeImages(input) {
  const images = (Array.isArray(input) ? input : []).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6);
  if (images.some((url) => !validImageUrl(url))) return { error: '圖片位址不正確' };
  return { images };
}

function normalizeNews(input = {}, id) {
  const images = normalizeImages(input.images);
  if (images.error) return images;
  const news = {
    id: String(id || input.id || ''),
    category: String(input.category || ''),
    title: cleanText(input.title, 180),
    publishedOn: cleanText(input.publishedOn, 20),
    updatedOn: cleanText(input.updatedOn || input.publishedOn, 20),
    publisher: cleanText(input.publisher, 80),
    body: cleanBody(input.body),
    images: images.images,
    legacyPath: String(input.legacyPath || '').startsWith('/announcements/articles/') ? String(input.legacyPath) : ''
  };
  if (!categoryKeys().includes(news.category)) return { error: '請選擇新聞分類' };
  if (news.title.length < 2) return { error: '請輸入新聞標題' };
  if (!news.publishedOn) return { error: '請輸入發布日期' };
  return { news };
}

function articlePath(item) {
  if (item.legacyPath) return item.legacyPath;
  return `/announcements/article.html?id=${encodeURIComponent(item.id)}`;
}

function reorderCategory(items, id, direction) {
  const current = items.find((item) => item.id === id);
  if (!current) return { error: '找不到這則新聞' };
  const sorted = items.filter((item) => item.category === current.category)
    .sort((a, b) => a.sortOrder - b.sortOrder || String(a.id).localeCompare(String(b.id)));
  const index = sorted.findIndex((item) => item.id === id);
  const target = index + (direction === 'up' ? -1 : 1);
  if (target < 0 || target >= sorted.length) return { orders: sorted.map((item, order) => ({ id: item.id, sortOrder: order })) };
  const [moved] = sorted.splice(index, 1);
  sorted.splice(target, 0, moved);
  return { orders: sorted.map((item, order) => ({ id: item.id, sortOrder: order })) };
}

function readImageDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return { error: '請上傳 JPG、PNG、WEBP 或 GIF 圖片' };
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return { error: '圖片上限為 2 MB' };
  const subtype = match[1].toLowerCase().split('/')[1].replace('jpeg', 'jpg');
  return { mimeType: match[1].toLowerCase(), buffer, extension: subtype };
}

function publicNews(row) {
  const images = Array.isArray(row.images) ? row.images : JSON.parse(row.images_json || row.imagesJson || '[]');
  const item = {
    id: row.id,
    category: row.category,
    title: row.title,
    publishedOn: row.published_on || row.publishedOn || '',
    updatedOn: row.updated_on || row.updatedOn || '',
    publisher: row.publisher || '',
    body: row.body || '',
    images,
    sortOrder: Number(row.sort_order ?? row.sortOrder ?? 0),
    legacyPath: row.legacy_path || row.legacyPath || ''
  };
  return { ...item, path: articlePath(item), customized: Boolean(item.body.trim() || item.images.length) };
}

function publicContact(row = {}) {
  const reportPhones = Array.isArray(row.reportPhones) ? row.reportPhones : [row.report_phone_primary, row.report_phone_secondary];
  return {
    address: row.address || DEFAULT_CONTACT.address,
    mapUrl: row.map_url || row.mapUrl || '',
    servicePhone: row.service_phone || row.servicePhone || DEFAULT_CONTACT.servicePhone,
    reportPhones: reportPhones.map((phone) => String(phone || '').trim()).filter(Boolean)
  };
}

function publicUnit(row) {
  const known = UNITS.find((unit) => unit.key === (row.unit_key || row.key));
  return {
    key: row.unit_key || row.key,
    name: row.unit_name || row.name || known?.name || '',
    path: row.page_path || row.path || known?.path || '',
    email: row.email || ''
  };
}

function seedNewsRows() {
  return NEWS_SEED.map((item) => ({ ...item, images: [] }));
}

module.exports = {
  CATEGORIES,
  DEFAULT_CONTACT,
  DEFAULT_FOOTER_QR,
  DEFAULT_POSTERS,
  HOME_NEWS_LIMIT,
  UNITS,
  articlePath,
  normalizeContact,
  normalizeNews,
  normalizePosters,
  normalizeUnits,
  publicContact,
  publicNews,
  publicPoster,
  publicUnit,
  readImageDataUrl,
  reorderCategory,
  validFooterQr,
  seedNewsRows
};
