const crypto = require('crypto');
const { getJsonBody, getSupabase, json, methodNotAllowed, requireAdmin, serviceErrorMessage, videoStorage } = require('../_lib/service');
const { readImageDataUrl } = require('../_lib/site-content');
const { mutateNews, readSite } = require('../_lib/site-supabase');

function imageExtension(mimeType) {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  return 'jpg';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    if (!requireAdmin(req, res)) return;
    const client = getSupabase();
    const body = await getJsonBody(req);
    if (body.action === 'image') {
      const image = readImageDataUrl(body.dataUrl);
      if (image.error) return json(res, 400, { error: image.error });
      const storedName = `site-news/${crypto.randomUUID()}.${imageExtension(image.mimeType)}`;
      const storage = await videoStorage(client);
      const uploaded = await storage.upload(storedName, image.buffer, { contentType: image.mimeType, upsert: false });
      if (uploaded.error) throw uploaded.error;
      const publicUrl = storage.getPublicUrl(storedName).data?.publicUrl || '';
      if (!publicUrl) return json(res, 500, { error: '圖片上傳後無法取得網址' });
      return json(res, 200, { url: publicUrl });
    }
    const result = await mutateNews(client, body);
    json(res, result.status, result.payload || { error: result.error });
  } catch (error) {
    const message = /site_news|schema cache|does not exist|Could not find/i.test(error?.message || '')
      ? '請先在 Supabase 執行 SUPABASE_SCHEMA.sql 裡的網站內容資料表。'
      : serviceErrorMessage(error, '儲存新聞失敗');
    json(res, 500, { error: message });
  }
};
