const { createSessionCookie, getJsonBody, getSupabase, json, methodNotAllowed, normalizeCaseNumber, normalizeCertificateNumber, publicCase } = require('../_lib/service');

async function handler(req, res) {
  try {
    if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
    const client = getSupabase();
    const body = req.method === 'GET' ? req.query : await getJsonBody(req);
    const citizenName = String(body.citizenName || '').trim();
    const certificateNumber = normalizeCertificateNumber(body.certificateNumber || body.nationalId);
    if (!citizenName || !certificateNumber) return json(res, 400, { error: '請輸入姓名與身分證號' });

    const found = await client.from('service_cases').select('*').eq('citizen_name', citizenName).eq('certificate_number', certificateNumber).order('created_at', { ascending: false });
    if (found.error) throw found.error;
    const openCases = (found.data || []).filter((item) => item.status === 'open');
    const requested = normalizeCaseNumber(body.caseNumber);
    let caseRow = openCases[0] || null;
    if (requested) {
      const matchedNumber = (found.data || []).find((item) => normalizeCaseNumber(item.case_number) === requested);
      if (!matchedNumber) return json(res, 404, { error: '查無資料' });
      if (matchedNumber.status !== 'open') return json(res, 403, { error: '案件尚未開通' });
      caseRow = matchedNumber;
    }
    if (!found.data?.length) return json(res, 404, { error: '查無資料' });
    if (!caseRow) return json(res, 403, { error: '案件尚未開通' });

    res.setHeader('Set-Cookie', createSessionCookie({ caseId: caseRow.id, citizenName, certificateNumber }));
    json(res, 200, { status: 'open', case: publicCase(caseRow), cases: openCases.map(publicCase) });
  } catch (error) {
    json(res, 500, { error: error.message || '申請開通失敗' });
  }
}

module.exports = handler;
