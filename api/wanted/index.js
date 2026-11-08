const crypto = require('crypto');
const { dataUrlToBuffer, getJsonBody, getSupabase, json, methodNotAllowed, requireStaff, safeName, serviceErrorMessage, videoStorage } = require('../_lib/service');

function normalizeNationalId(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function publicRecord(row, includeNationalId = false) {
  const record = {
    id: row.id,
    personName: row.person_name,
    reason: row.reason,
    photoUrl: row.photo_url || ''
  };
  if (includeNationalId) record.nationalId = row.national_id;
  return record;
}

async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
  const session = requireStaff(req, res);
  if (!session) return;
  try {
    const client = getSupabase();
    if (req.method === 'GET') {
      const result = await client.from('service_wanted_persons').select('*').order('created_at', { ascending: false });
      if (result.error) throw result.error;
      return json(res, 200, { records: (result.data || []).map((row) => publicRecord(row, true)) });
    }

    const body = await getJsonBody(req);
    const nationalId = normalizeNationalId(body.nationalId);
    const personName = String(body.personName || '').trim();
    const reason = String(body.reason || '').trim();
    if (!nationalId || !personName || !reason) {
      return json(res, 400, { error: '請輸入身分證字號、姓名與通緝事由' });
    }

    let photoUrl = '';
    let photoStored = '';
    if (body.photoDataUrl) {
      const parsed = dataUrlToBuffer(body.photoDataUrl);
      if (!parsed) return json(res, 400, { error: '照片格式錯誤，請重新上傳' });
      if (!parsed.mimeType.startsWith('image/')) return json(res, 400, { error: '照片只接受圖片' });
      if (parsed.buffer.length > 2 * 1024 * 1024) return json(res, 413, { error: '照片上限為 2 MB' });
      photoStored = `wanted/${crypto.randomUUID()}-${safeName('photo.jpg')}`;
      const storage = await videoStorage(client);
      const uploaded = await storage.upload(photoStored, parsed.buffer, { contentType: parsed.mimeType, upsert: false });
      if (uploaded.error) throw uploaded.error;
      photoUrl = storage.getPublicUrl(photoStored).data?.publicUrl || '';
    }

    const inserted = await client.from('service_wanted_persons').insert({
      national_id: nationalId,
      person_name: personName,
      reason,
      photo_url: photoUrl,
      photo_stored: photoStored
    }).select('*').single();
    if (inserted.error) throw inserted.error;
    return json(res, 200, { record: publicRecord(inserted.data, true) });
  } catch (error) {
    return json(res, 500, { error: serviceErrorMessage(error, '通緝資料儲存失敗') });
  }
}

module.exports = handler;
