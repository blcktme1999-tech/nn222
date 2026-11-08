'use strict';

const crypto = require('crypto');
const {
  DEFAULT_CONTACT,
  DEFAULT_FOOTER_QR,
  DEFAULT_POSTERS,
  UNITS,
  normalizeContact,
  normalizeNews,
  normalizePosters,
  normalizeUnits,
  publicContact,
  publicNews,
  publicPoster,
  publicUnit,
  reorderCategory,
  validFooterQr,
  seedNewsRows
} = require('./site-content');

function newsRecord(row) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    published_on: row.publishedOn,
    updated_on: row.updatedOn,
    publisher: row.publisher,
    body: row.body,
    images_json: JSON.stringify(row.images || []),
    sort_order: row.sortOrder,
    legacy_path: row.legacyPath || ''
  };
}

async function readSite(client) {
  await ensureSeed(client);
  const settings = await client.from('site_settings').select('*').eq('id', 1).single();
  if (settings.error) throw settings.error;
  const units = await client.from('site_unit_emails').select('*');
  if (units.error) throw units.error;
  const news = await client.from('site_news').select('*').order('sort_order', { ascending: true });
  if (news.error) throw news.error;
  const unitRows = new Map((units.data || []).map((row) => [row.unit_key, row]));
  return {
    contact: publicContact(settings.data),
    units: UNITS.map((unit) => publicUnit(unitRows.get(unit.key) || unit)),
    news: (news.data || []).map(publicNews),
    posters: await readPosters(client),
    footerQr: await readFooterQr(client)
  };
}

async function readFooterQr(client) {
  const footer = await client.from('site_footer').select('image_url').eq('id', 1).maybeSingle();
  if (footer.error || !validFooterQr(footer.data?.image_url)) return DEFAULT_FOOTER_QR;
  return footer.data.image_url;
}

async function saveFooterQr(client, body) {
  const url = String(body.url || '').trim();
  if (!validFooterQr(url)) return { status: 400, error: '請上傳二維碼圖片' };
  const saved = await client.from('site_footer').upsert({ id: 1, image_url: url });
  if (saved.error) {
    if (missingPostersTable(saved.error) || /site_footer/i.test(saved.error.message || '')) {
      return { status: 500, error: '請先在 Supabase 執行 SUPABASE_SCHEMA.sql 裡的網站內容資料表。' };
    }
    throw saved.error;
  }
  return { status: 200, payload: { footerQr: url } };
}

function missingPostersTable(error) {
  return /site_posters|schema cache|does not exist|Could not find/i.test(error?.message || '');
}

async function readPosters(client) {
  const posters = await client.from('site_posters').select('*').order('sort_order', { ascending: true });
  if (posters.error) {
    if (missingPostersTable(posters.error)) return DEFAULT_POSTERS.map((item) => ({ ...item }));
    throw posters.error;
  }
  const rows = (posters.data || []).map(publicPoster).filter((item) => item.url);
  return rows.length ? rows : DEFAULT_POSTERS.map((item) => ({ ...item }));
}

async function ensureSeed(client) {
  const settings = await client.from('site_settings').select('id').eq('id', 1).maybeSingle();
  if (settings.error) throw settings.error;
  if (!settings.data) {
    const inserted = await client.from('site_settings').insert({
      id: 1,
      address: DEFAULT_CONTACT.address,
      map_url: '',
      service_phone: DEFAULT_CONTACT.servicePhone,
      report_phone_primary: DEFAULT_CONTACT.reportPhones[0],
      report_phone_secondary: DEFAULT_CONTACT.reportPhones[1]
    });
    if (inserted.error) throw inserted.error;
  }
  const units = await client.from('site_unit_emails').select('unit_key');
  if (units.error) throw units.error;
  const existing = new Set((units.data || []).map((row) => row.unit_key));
  const missing = UNITS.filter((unit) => !existing.has(unit.key)).map((unit) => ({
    unit_key: unit.key, unit_name: unit.name, page_path: unit.path, email: ''
  }));
  if (missing.length) {
    const inserted = await client.from('site_unit_emails').insert(missing);
    if (inserted.error) throw inserted.error;
  }
  const news = await client.from('site_news').select('id').limit(1);
  if (news.error) throw news.error;
  if (!(news.data || []).length) {
    const inserted = await client.from('site_news').insert(seedNewsRows().map(newsRecord));
    if (inserted.error && !/duplicate|unique/i.test(inserted.error.message || '')) throw inserted.error;
  }
}

async function saveSite(client, body) {
  const contactResult = normalizeContact(body.contact || {});
  if (contactResult.error) return { status: 400, error: contactResult.error };
  const unitResult = normalizeUnits(body.units);
  if (unitResult.error) return { status: 400, error: unitResult.error };
  const contact = contactResult.contact;
  const updated = await client.from('site_settings').update({
    address: contact.address,
    map_url: contact.mapUrl,
    service_phone: contact.servicePhone,
    report_phone_primary: contact.reportPhones[0] || '',
    report_phone_secondary: contact.reportPhones[1] || ''
  }).eq('id', 1);
  if (updated.error) throw updated.error;
  for (const unit of unitResult.units) {
    const saved = await client.from('site_unit_emails').update({ email: unit.email }).eq('unit_key', unit.key);
    if (saved.error) throw saved.error;
  }
  return { status: 200, payload: await readSite(client) };
}

async function savePosters(client, body) {
  const result = normalizePosters(body.posters);
  if (result.error) return { status: 400, error: result.error };
  const existing = await client.from('site_posters').select('id');
  if (existing.error) {
    if (missingPostersTable(existing.error)) return { status: 500, error: '請先在 Supabase 執行 SUPABASE_SCHEMA.sql 裡的網站內容資料表。' };
    throw existing.error;
  }
  const rows = result.posters.map((item, index) => ({
    id: crypto.randomUUID(),
    image_url: item.url,
    sort_order: index
  }));
  const inserted = await client.from('site_posters').insert(rows);
  if (inserted.error) throw inserted.error;
  const oldIds = (existing.data || []).map((row) => row.id);
  if (oldIds.length) {
    const removed = await client.from('site_posters').delete().in('id', oldIds);
    if (removed.error) throw removed.error;
  }
  return { status: 200, payload: await readSite(client) };
}

async function mutateNews(client, body) {
  const action = String(body.action || 'create');
  if (action === 'delete') {
    const removed = await client.from('site_news').delete().eq('id', String(body.id || '')).select('id');
    if (removed.error) throw removed.error;
    if (!(removed.data || []).length) return { status: 404, error: '找不到這則新聞' };
    return { status: 200, payload: await readSite(client) };
  }
  if (action === 'move') {
    const rows = await client.from('site_news').select('*');
    if (rows.error) throw rows.error;
    const moved = reorderCategory((rows.data || []).map(publicNews), String(body.id || ''), body.direction === 'up' ? 'up' : 'down');
    if (moved.error) return { status: 404, error: moved.error };
    for (const order of moved.orders) {
      const saved = await client.from('site_news').update({ sort_order: order.sortOrder }).eq('id', order.id);
      if (saved.error) throw saved.error;
    }
    return { status: 200, payload: await readSite(client) };
  }
  const newsResult = normalizeNews(body, action === 'update' ? body.id : crypto.randomUUID());
  if (newsResult.error) return { status: 400, error: newsResult.error };
  const news = newsResult.news;
  if (action === 'update') {
    const existing = await client.from('site_news').select('id, legacy_path').eq('id', news.id).maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return { status: 404, error: '找不到這則新聞' };
    const saved = await client.from('site_news').update({
      category: news.category,
      title: news.title,
      published_on: news.publishedOn,
      updated_on: news.updatedOn,
      publisher: news.publisher,
      body: news.body,
      images_json: JSON.stringify(news.images)
    }).eq('id', news.id);
    if (saved.error) throw saved.error;
    return { status: 200, payload: await readSite(client) };
  }
  const front = await client.from('site_news').select('sort_order').eq('category', news.category).order('sort_order', { ascending: true }).limit(1);
  if (front.error) throw front.error;
  const sortOrder = front.data?.[0] ? Number(front.data[0].sort_order) - 1 : 0;
  const inserted = await client.from('site_news').insert({ ...newsRecord(news), sort_order: sortOrder });
  if (inserted.error) throw inserted.error;
  return { status: 200, payload: await readSite(client) };
}

module.exports = { mutateNews, readSite, saveFooterQr, savePosters, saveSite };
