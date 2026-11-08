const { getJsonBody, getSupabase, json, methodNotAllowed, normalizeCaseNumber, normalizeCertificateNumber, serviceErrorMessage } = require('../_lib/service');

async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const body = await getJsonBody(req);
    const citizenName = String(body.citizenName || '').trim();
    const certificateNumber = normalizeCertificateNumber(body.certificateNumber);
    const caseNumber = normalizeCaseNumber(body.caseNumber);
    const kind = body.kind === 'interview' || body.kind === 'document' ? body.kind : '';
    const image = String(body.image || '');
    if (!citizenName || !certificateNumber || !caseNumber || !kind) return json(res, 400, { error: '請完成簽名資料' });
    if (!/^data:image\/png;base64,[a-z0-9+/=\s]+$/i.test(image) || image.length > 700000) {
      return json(res, 400, { error: '簽名檔無法儲存' });
    }
    const client = getSupabase();
    const found = await client.from('service_cases').select('id').eq('citizen_name', citizenName).eq('certificate_number', certificateNumber).eq('case_number', caseNumber).limit(1);
    if (found.error) throw found.error;
    const row = found.data?.[0];
    if (!row) return json(res, 404, { error: '查無資料' });
    const patch = kind === 'interview' ? { interview_signature: image } : { document_signature: image };
    const updated = await client.from('service_cases').update(patch).eq('id', row.id);
    if (updated.error) throw updated.error;
    json(res, 200, { ok: true });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '簽名檔儲存失敗') });
  }
}

module.exports = handler;
