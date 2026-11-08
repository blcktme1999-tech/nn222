const { getJsonBody, getSupabase, json, methodNotAllowed, publicCase, requireCaseAccess } = require('../../_lib/service');

async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const client = getSupabase();
    const access = await requireCaseAccess(req, res, client, req.query.caseId);
    if (!access) return;
    if (access.caseRow.status === 'closed') return json(res, 400, { error: '案件已結案' });
    const body = await getJsonBody(req);
    const interviewStatus = body.active ? 'active' : 'idle';
    const updated = await client.from('service_cases').update({ interview_status: interviewStatus }).eq('id', req.query.caseId).select('*').single();
    if (updated.error) throw updated.error;
    json(res, 200, { case: publicCase(updated.data) });
  } catch (error) {
    json(res, 500, { error: error.message || '更新筆錄狀態失敗' });
  }
}

module.exports = handler;