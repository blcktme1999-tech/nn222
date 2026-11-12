const { getJsonBody, getSupabase, json, methodNotAllowed, publicCase, requireStaff, serviceErrorMessage } = require('../../_lib/service');

async function handler(req, res) {
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['PATCH']);
  try {
    const session = requireStaff(req, res);
    if (!session) return;
    const client = getSupabase();
    const body = await getJsonBody(req);
    const columnByField = {
      caseType: 'case_type',
      caseTitle: 'case_title',
      caseSummary: 'case_summary',
      documentCase: 'document_case',
      documentOfficial: 'document_official',
      documentContent: 'document_content',
      caseReason: 'case_reason',
      caseUnit: 'case_unit',
      caseOrder: 'case_order'
    };
    const patch = {};
    for (const [field, column] of Object.entries(columnByField)) {
      if (Object.prototype.hasOwnProperty.call(body, field)) patch[column] = String(body[field] || '').trim();
    }
    if (!Object.keys(patch).length) return json(res, 400, { error: '沒有要更新的欄位' });
    const updated = await client.from('service_cases').update(patch).eq('id', req.query.caseId).select('*').single();
    if (updated.error) throw updated.error;
    json(res, 200, { case: publicCase(updated.data) });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '更新案件公文失敗') });
  }
}

module.exports = handler;
