const { getJsonBody, getSupabase, json, methodNotAllowed, requireAdmin, serviceErrorMessage } = require('../_lib/service');
const { readSite, saveSite } = require('../_lib/site-supabase');

module.exports = async function handler(req, res) {
  if (!['GET', 'PUT'].includes(req.method)) return methodNotAllowed(res, ['GET', 'PUT']);
  try {
    const client = getSupabase();
    if (req.method === 'GET') return json(res, 200, await readSite(client));
    if (!requireAdmin(req, res)) return;
    const result = await saveSite(client, await getJsonBody(req));
    json(res, result.status, result.payload || { error: result.error });
  } catch (error) {
    const message = /site_settings|site_unit_emails|site_news|site_posters|schema cache|does not exist|Could not find/i.test(error?.message || '')
      ? '請先在 Supabase 執行 SUPABASE_SCHEMA.sql 裡的網站內容資料表。'
      : serviceErrorMessage(error, '讀取網站內容失敗');
    json(res, 500, { error: message });
  }
};
