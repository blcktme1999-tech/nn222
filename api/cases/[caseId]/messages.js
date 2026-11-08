const { getJsonBody, getSupabase, json, methodNotAllowed, publicMessage, requireCaseAccess } = require('../../_lib/service');

async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const client = getSupabase();
    const access = await requireCaseAccess(req, res, client, req.query.caseId);
    if (!access) return;

    if (req.method === 'GET') {
      const result = await client.from('service_messages').select('*').eq('case_id', req.query.caseId).order('created_at', { ascending: true });
      if (result.error) throw result.error;
      return json(res, 200, { messages: (result.data || []).map(publicMessage) });
    }

    const body = await getJsonBody(req);
    const text = String(body.body || '').trim();
    if (!text) return json(res, 400, { error: '請輸入訊息' });
    const user = access.session.user;
    const senderType = user?.role === 'admin' ? 'admin' : user ? 'agent' : 'citizen';
    const senderName = user?.displayName || access.session.citizenName || access.caseRow.citizen_name || '民眾';
    const inserted = await client.from('service_messages').insert({ case_id: req.query.caseId, sender_type: senderType, sender_name: senderName, body: text }).select('*').single();
    if (inserted.error) throw inserted.error;
    json(res, 200, { message: publicMessage(inserted.data) });
  } catch (error) {
    json(res, 500, { error: error.message || '訊息處理失敗' });
  }
}

module.exports = handler;
