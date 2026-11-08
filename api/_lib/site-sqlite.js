'use strict';

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
  validFooterQr,
  publicNews,
  publicPoster,
  publicUnit,
  reorderCategory,
  seedNewsRows
} = require('./site-content');

function ensureSiteTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      address TEXT NOT NULL,
      map_url TEXT NOT NULL DEFAULT '',
      service_phone TEXT NOT NULL,
      report_phone_primary TEXT NOT NULL DEFAULT '',
      report_phone_secondary TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS site_unit_emails (
      unit_key TEXT PRIMARY KEY,
      unit_name TEXT NOT NULL,
      page_path TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS site_news (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      published_on TEXT NOT NULL,
      updated_on TEXT NOT NULL DEFAULT '',
      publisher TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      images_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      legacy_path TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS site_posters (
      id TEXT PRIMARY KEY,
      image_url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS site_footer (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      image_url TEXT NOT NULL
    );
  `);
  if (!db.prepare('SELECT id FROM site_footer WHERE id = 1').get()) {
    db.prepare('INSERT INTO site_footer (id, image_url) VALUES (1, ?)').run(DEFAULT_FOOTER_QR);
  }
  if (!db.prepare('SELECT id FROM site_settings WHERE id = 1').get()) {
    db.prepare(`INSERT INTO site_settings (id, address, map_url, service_phone, report_phone_primary, report_phone_secondary)
      VALUES (1, ?, '', ?, ?, ?)`).run(DEFAULT_CONTACT.address, DEFAULT_CONTACT.servicePhone, DEFAULT_CONTACT.reportPhones[0], DEFAULT_CONTACT.reportPhones[1]);
  }
  const insertUnit = db.prepare('INSERT OR IGNORE INTO site_unit_emails (unit_key, unit_name, page_path, email) VALUES (?, ?, ?, \'\')');
  for (const unit of UNITS) insertUnit.run(unit.key, unit.name, unit.path);
  if (!db.prepare('SELECT id FROM site_news LIMIT 1').get()) {
    const insertNews = db.prepare(`INSERT INTO site_news
      (id, category, title, published_on, updated_on, publisher, body, images_json, sort_order, legacy_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`);
    const seed = db.transaction((rows) => {
      for (const row of rows) insertNews.run(row.id, row.category, row.title, row.publishedOn, row.updatedOn, row.publisher, row.body, row.sortOrder, row.legacyPath);
    });
    seed(seedNewsRows());
  }
}

function readSite(db) {
  const settings = db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  const units = db.prepare('SELECT * FROM site_unit_emails ORDER BY unit_name').all().map(publicUnit);
  const orderedUnits = UNITS.map((unit) => units.find((item) => item.key === unit.key) || publicUnit(unit));
  const news = db.prepare('SELECT * FROM site_news ORDER BY sort_order ASC, id ASC').all().map(publicNews);
  const posterRows = db.prepare('SELECT * FROM site_posters ORDER BY sort_order ASC, id ASC').all().map(publicPoster).filter((item) => item.url);
  const footer = db.prepare('SELECT image_url FROM site_footer WHERE id = 1').get();
  return {
    contact: publicContact(settings),
    units: orderedUnits,
    news,
    posters: posterRows.length ? posterRows : DEFAULT_POSTERS.map((item) => ({ ...item })),
    footerQr: footer && validFooterQr(footer.image_url) ? footer.image_url : DEFAULT_FOOTER_QR
  };
}

function saveFooterQr(db, body) {
  const url = String(body.url || '').trim();
  if (!validFooterQr(url)) return { status: 400, error: '請上傳二維碼圖片' };
  db.prepare('INSERT INTO site_footer (id, image_url) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET image_url = excluded.image_url').run(url);
  return { status: 200, payload: { footerQr: url } };
}

function savePosters(db, body) {
  const result = normalizePosters(body.posters);
  if (result.error) return { status: 400, error: result.error };
  const insert = db.prepare('INSERT INTO site_posters (id, image_url, sort_order) VALUES (?, ?, ?)');
  const save = db.transaction(() => {
    db.prepare('DELETE FROM site_posters').run();
    result.posters.forEach((item, index) => insert.run(id(), item.url, index));
  });
  save();
  return { status: 200, payload: readSite(db) };
}

function saveContact(db, body) {
  const contactResult = normalizeContact(body.contact || {});
  if (contactResult.error) return { status: 400, error: contactResult.error };
  const unitResult = normalizeUnits(body.units);
  if (unitResult.error) return { status: 400, error: unitResult.error };
  const contact = contactResult.contact;
  const save = db.transaction(() => {
    db.prepare(`UPDATE site_settings SET address = ?, map_url = ?, service_phone = ?, report_phone_primary = ?, report_phone_secondary = ? WHERE id = 1`)
      .run(contact.address, contact.mapUrl, contact.servicePhone, contact.reportPhones[0] || '', contact.reportPhones[1] || '');
    const update = db.prepare('UPDATE site_unit_emails SET email = ? WHERE unit_key = ?');
    for (const unit of unitResult.units) update.run(unit.email, unit.key);
  });
  save();
  return { status: 200, payload: readSite(db) };
}

function insertNews(db, news) {
  const front = db.prepare('SELECT sort_order FROM site_news WHERE category = ? ORDER BY sort_order ASC LIMIT 1').get(news.category);
  const sortOrder = front ? front.sort_order - 1 : 0;
  db.prepare(`INSERT INTO site_news
    (id, category, title, published_on, updated_on, publisher, body, images_json, sort_order, legacy_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '')`).run(
    news.id, news.category, news.title, news.publishedOn, news.updatedOn, news.publisher, news.body, JSON.stringify(news.images), sortOrder
  );
}

function mutateNews(db, body, id) {
  const action = String(body.action || 'create');
  if (action === 'delete') {
    const removed = db.prepare('DELETE FROM site_news WHERE id = ?').run(String(body.id || ''));
    if (!removed.changes) return { status: 404, error: '找不到這則新聞' };
    return { status: 200, payload: readSite(db) };
  }
  if (action === 'move') {
    const rows = db.prepare('SELECT * FROM site_news').all().map(publicNews);
    const moved = reorderCategory(rows, String(body.id || ''), body.direction === 'up' ? 'up' : 'down');
    if (moved.error) return { status: 404, error: moved.error };
    const update = db.prepare('UPDATE site_news SET sort_order = ? WHERE id = ?');
    const save = db.transaction(() => {
      for (const order of moved.orders) update.run(order.sortOrder, order.id);
    });
    save();
    return { status: 200, payload: readSite(db) };
  }
  const newsResult = normalizeNews(body, action === 'update' ? body.id : id());
  if (newsResult.error) return { status: 400, error: newsResult.error };
  const news = newsResult.news;
  if (action === 'update') {
    const existing = db.prepare('SELECT legacy_path FROM site_news WHERE id = ?').get(news.id);
    if (!existing) return { status: 404, error: '找不到這則新聞' };
    db.prepare(`UPDATE site_news SET category = ?, title = ?, published_on = ?, updated_on = ?, publisher = ?, body = ?, images_json = ? WHERE id = ?`)
      .run(news.category, news.title, news.publishedOn, news.updatedOn, news.publisher, news.body, JSON.stringify(news.images), news.id);
    return { status: 200, payload: readSite(db) };
  }
  insertNews(db, news);
  return { status: 200, payload: readSite(db) };
}

function id() {
  return require('crypto').randomUUID();
}

module.exports = { ensureSiteTables, mutateNews, readSite, saveContact, saveFooterQr, savePosters };
