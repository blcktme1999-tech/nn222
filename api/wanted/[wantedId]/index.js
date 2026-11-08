const { getSupabase, json, methodNotAllowed, requireStaff, serviceErrorMessage, videoStorage } = require('../../_lib/service');

async function handler(req, res) {
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);
  const session = requireStaff(req, res);
  if (!session) return;
  try {
    const client = getSupabase();
    const existing = await client.from('service_wanted_persons').select('*').eq('id', req.query.wantedId).maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return json(res, 404, { error: '找不到通緝資料' });
    if (existing.data.photo_stored) {
      const removed = await (await videoStorage(client)).remove([existing.data.photo_stored]);
      if (removed.error) throw removed.error;
    }
    const deleted = await client.from('service_wanted_persons').delete().eq('id', existing.data.id);
    if (deleted.error) throw deleted.error;
    return json(res, 200, { ok: true });
  } catch (error) {
    return json(res, 500, { error: serviceErrorMessage(error, '刪除通緝資料失敗') });
  }
}

module.exports = handler;
