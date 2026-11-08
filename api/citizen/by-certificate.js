const { getJsonBody, getSupabase, json, methodNotAllowed, normalizeCertificateNumber, serviceErrorMessage } = require('../_lib/service');

async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const body = await getJsonBody(req);
    const certificateNumber = normalizeCertificateNumber(body.certificateNumber || body.nationalId);
    if (!certificateNumber) return json(res, 400, { error: '請輸入身分證字號' });
    const client = getSupabase();
    const found = await client.from('service_cases').select('id, citizen_name, case_number, status').eq('certificate_number', certificateNumber).order('created_at', { ascending: false });
    if (found.error) throw found.error;
    if (!found.data?.length) return json(res, 404, { error: '查無資料' });
    json(res, 200, {
      cases: found.data.map((row) => ({
        id: row.id,
        citizenName: row.citizen_name,
        caseNumber: row.case_number,
        status: row.status
      }))
    });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '身分證查詢失敗') });
  }
}

module.exports = handler;
