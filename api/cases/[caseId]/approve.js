const { getSupabase, json, methodNotAllowed, publicCase, requireAdmin } = require('../../_lib/service');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const session = requireAdmin(req, res);
    if (!session) return;
    const client = getSupabase();
    const caseId = req.query.caseId;
    const updated = await client.from('service_cases').update({ status: 'open', approved_at: new Date().toISOString() }).eq('id', caseId).select('*').single();
    if (updated.error) throw updated.error;
    const message = await client.from('service_messages').insert({ case_id: caseId, sender_type: 'system', sender_name: '警政系統', body: '已開通線上報案系統。' });
    if (message.error) throw message.error;
    json(res, 200, { case: publicCase(updated.data) });
  } catch (error) {
    json(res, 500, { error: error.message || '審核案件失敗' });
  }
};
