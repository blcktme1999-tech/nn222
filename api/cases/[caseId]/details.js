const { getJsonBody, getSupabase, json, methodNotAllowed, publicCase, requireStaff, serviceErrorMessage } = require('../../_lib/service');

async function handler(req, res) {
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['PATCH']);
  try {
    const session = requireStaff(req, res);
    if (!session) return;
    const client = getSupabase();
    const body = await getJsonBody(req);
    const updated = await client.from('service_cases').update({
      case_type: String(body.caseType || '').trim(),
      case_title: String(body.caseTitle || '').trim(),
      case_summary: String(body.caseSummary || '').trim(),
      document_case: String(body.documentCase || '').trim(),
      document_official: String(body.documentOfficial || '').trim(),
      document_content: String(body.documentContent || '').trim(),
      case_reason: String(body.caseReason || '').trim(),
      case_unit: String(body.caseUnit || '').trim(),
      case_order: String(body.caseOrder || '').trim()
    }).eq('id', req.query.caseId).select('*').single();
    if (updated.error) throw updated.error;
    json(res, 200, { case: publicCase(updated.data) });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '更新案件公文失敗') });
  }
}

module.exports = handler;
