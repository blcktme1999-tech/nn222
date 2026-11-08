const { getJsonBody, getSupabase, json, methodNotAllowed, normalizeCaseNumber, normalizeCertificateNumber, publicCase, publicFile, serviceErrorMessage } = require('../_lib/service');

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const body = req.method === 'GET' ? req.query : await getJsonBody(req);
    const citizenName = String(body.citizenName || '').trim();
    const certificateNumber = normalizeCertificateNumber(body.certificateNumber);
    const caseNumber = normalizeCaseNumber(body.caseNumber);
    if (!citizenName || !certificateNumber || !caseNumber) {
      return json(res, 400, { error: '請輸入姓名、身分證字號與案件編號' });
    }

    const client = getSupabase();
    const result = await client
      .from('service_cases')
      .select('*')
      .eq('citizen_name', citizenName)
      .eq('certificate_number', certificateNumber)
      .eq('case_number', caseNumber)
      .order('created_at', { ascending: false });
    if (result.error) throw result.error;
    const rows = result.data || [];
    if (!rows.length) return json(res, 404, { error: '查無資料' });

    const files = await client.from('service_files').select('*').in('case_id', rows.map((row) => row.id)).order('created_at', { ascending: false });
    if (files.error) throw files.error;
    const filesByCaseId = (files.data || []).reduce((groups, file) => {
      const item = publicFile(file);
      (groups[file.case_id] ||= []).push(item);
      return groups;
    }, {});
    json(res, 200, { cases: rows.map(publicCase), filesByCaseId });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '案件查詢失敗') });
  }
}

module.exports = handler;
