const { getJsonBody, getSupabase, json, methodNotAllowed, normalizeCertificateNumber, publicCase, publicFile, serviceErrorMessage } = require('../_lib/service');

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
    const certificateNumber = normalizeCertificateNumber(body.certificateNumber || body.nationalId);
    if (!citizenName || !certificateNumber) {
      return json(res, 400, { error: '請輸入姓名與證號' });
    }

    const client = getSupabase();
    const result = await client
      .from('service_cases')
      .select('*')
      .eq('citizen_name', citizenName)
      .eq('certificate_number', certificateNumber)
      .order('created_at', { ascending: false });
    if (result.error) throw result.error;

    const caseIds = (result.data || []).map((item) => item.id);
    let filesByCaseId = {};
    if (caseIds.length) {
      const files = await client.from('service_files').select('*').in('case_id', caseIds).order('created_at', { ascending: false });
      if (files.error) throw files.error;
      filesByCaseId = (files.data || []).reduce((groups, file) => {
        (groups[file.case_id] ||= []).push(publicFile(file));
        return groups;
      }, {});
    }
    json(res, 200, { cases: (result.data || []).map(publicCase), filesByCaseId });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '案件公文查詢失敗') });
  }
}

module.exports = handler;
