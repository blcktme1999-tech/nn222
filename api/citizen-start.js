const { createSessionCookie, getSupabase, json, methodNotAllowed, normalizeCertificateNumber, publicCase } = require('./_lib/service');

function getQuery(req) {
  const host = req.headers.host || 'localhost';
  return new URL(req.url || '/', `https://${host}`).searchParams;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const client = getSupabase();
    const query = getQuery(req);
    const citizenName = String(query.get('citizenName') || '').trim();
    const certificateNumber = normalizeCertificateNumber(query.get('certificateNumber') || query.get('nationalId'));
    if (!citizenName || !certificateNumber) return json(res, 400, { error: '請輸入姓名與身分證號' });

    const found = await client.from('service_cases').select('*').eq('citizen_name', citizenName).eq('certificate_number', certificateNumber).order('created_at', { ascending: false });
    if (found.error) throw found.error;
    const openCases = (found.data || []).filter((item) => item.status === 'open');
    const caseRow = openCases[0] || null;

    if (!found.data?.length) return json(res, 404, { error: '查無資料' });
    if (!caseRow) return json(res, 403, { error: '案件尚未開通' });

    res.setHeader('Set-Cookie', createSessionCookie({ caseId: caseRow.id, citizenName, certificateNumber }));
    json(res, 200, { status: 'open', case: publicCase(caseRow), cases: openCases.map(publicCase) });
  } catch (error) {
    json(res, 500, { error: error.message || '申請開通失敗' });
  }
};