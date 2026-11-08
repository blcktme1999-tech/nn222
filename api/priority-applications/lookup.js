const { getJsonBody, getSupabase, json, loadSupabasePriorityApplications, methodNotAllowed, serviceErrorMessage } = require('../_lib/service');
const { matchingIdentity } = require('./index');

async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const client = getSupabase();
    const identity = await matchingIdentity(client, await getJsonBody(req));
    if (identity.error) return json(res, identity.status, { error: identity.error });
    const applications = await loadSupabasePriorityApplications(client, identity);
    json(res, 200, { applications });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '優先調查申請查詢失敗') });
  }
}

module.exports = handler;
