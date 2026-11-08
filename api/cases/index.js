const { ensureCaseNumber, getJsonBody, getSupabase, json, methodNotAllowed, normalizeCertificateNumber, publicCase, requireStaff, serviceErrorMessage } = require('../_lib/service');

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const client = getSupabase();

    if (req.method === 'POST') {
      const session = requireStaff(req, res);
      if (!session) return;
      const body = await getJsonBody(req);
      const citizenName = String(body.citizenName || '').trim();
      const caseNumber = ensureCaseNumber(body.caseNumber || body.nationalId);
      const certificateNumber = normalizeCertificateNumber(body.certificateNumber);
      const caseType = String(body.caseType || '').trim();
      const caseTitle = String(body.caseTitle || '').trim();
      const caseSummary = String(body.caseSummary || '').trim();
      const documentCase = String(body.documentCase || '').trim();
      const documentOfficial = String(body.documentOfficial || '').trim();
      const documentContent = String(body.documentContent || '').trim();
      if (!citizenName || !caseNumber || !certificateNumber) return json(res, 400, { error: '請輸入姓名、證號與案號' });

      const inserted = await client.from('service_cases').insert({
        citizen_name: citizenName,
        national_id: caseNumber,
        case_number: caseNumber,
        certificate_number: certificateNumber,
        case_type: caseType,
        case_title: caseTitle,
        case_summary: caseSummary,
        document_case: documentCase,
        document_official: documentOfficial,
        document_content: documentContent,
        status: 'open',
        approved_at: new Date().toISOString()
      }).select('*').single();
      if (inserted.error) throw inserted.error;
      const caseRow = inserted.data;
      const creator = session.user?.displayName || '服務人員';
      await client.from('service_messages').insert({ case_id: caseRow.id, sender_type: 'system', sender_name: '警政系統', body: `${creator}已新增案件並開通線上報案服務。` });
      return json(res, 200, { case: publicCase(caseRow) });
    }

    const session = requireStaff(req, res);
    if (!session) return;
    const result = await client.from('service_cases').select('*').order('created_at', { ascending: false });
    if (result.error) throw result.error;
    json(res, 200, { cases: (result.data || []).map(publicCase) });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '讀取案件失敗') });
  }
};
