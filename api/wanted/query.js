const { getJsonBody, getSupabase, json, methodNotAllowed, serviceErrorMessage } = require('../_lib/service');

function normalizeNationalId(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const body = await getJsonBody(req);
    const nationalId = normalizeNationalId(body.nationalId);
    if (!nationalId) return json(res, 400, { error: '請輸入身分證字號' });
    const client = getSupabase();
    const result = await client.from('service_wanted_persons').select('*').eq('national_id', nationalId).order('created_at', { ascending: false });
    if (result.error) throw result.error;
    if (!result.data?.length) return json(res, 404, { error: '查無資料' });
    return json(res, 200, {
      records: result.data.map((row) => ({
        id: row.id,
        personName: row.person_name,
        reason: row.reason,
        photoUrl: row.photo_url || ''
      }))
    });
  } catch (error) {
    return json(res, 500, { error: serviceErrorMessage(error, '通緝查詢失敗') });
  }
}

module.exports = handler;
