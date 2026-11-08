const { appendPriorityMessage, getJsonBody, getSupabase, json, loadSupabasePriorityApplications, methodNotAllowed, publicPriorityApplication, readSession, serviceErrorMessage } = require('../_lib/service');
const { matchingIdentity } = require('./index');

async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const client = getSupabase();
    const body = await getJsonBody(req);
    const text = String(body.body || '').trim();
    if (!text) return json(res, 400, { error: '請輸入訊息' });
    const session = readSession(req);
    const citizenRequest = Boolean(String(body.citizenName || '').trim() || String(body.certificateNumber || '').trim());
    const staff = !citizenRequest && session?.user && ['admin', 'agent'].includes(session.user.role);
    let applications = [];
    if (citizenRequest) {
      const identity = await matchingIdentity(client, body);
      if (identity.error) return json(res, identity.status, { error: identity.error });
      applications = await loadSupabasePriorityApplications(client, identity);
    } else if (staff) applications = await loadSupabasePriorityApplications(client);
    else return json(res, 401, { error: '請先登入' });
    for (const application of applications) {
      const result = appendPriorityMessage(application.entries, body.entryId, staff ? 'staff' : 'citizen', text);
      if (result.error) continue;
      const updated = await client.from('priority_applications').update({ entries_json: JSON.stringify(result.entries) }).eq('id', application.id).select('*').single();
      if (updated.error) throw updated.error;
      return json(res, 200, { application: publicPriorityApplication(updated.data) });
    }
    json(res, 404, { error: staff ? '找不到這筆申請' : '查無資料' });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '優先調查訊息送出失敗') });
  }
}

module.exports = handler;
