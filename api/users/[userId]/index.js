const { getSupabase, json, methodNotAllowed, requireAdmin, serviceErrorMessage } = require('../../_lib/service');

async function handler(req, res) {
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);
  const session = requireAdmin(req, res);
  if (!session) return;
  try {
    const userId = String(req.query.userId || '');
    if (!userId) return json(res, 400, { error: '缺少帳號編號' });
    if (session.user?.id === userId) return json(res, 400, { error: '不能刪除目前登入的帳號' });

    const client = getSupabase();
    const existing = await client.from('service_users').select('id, role, display_name').eq('id', userId).maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return json(res, 404, { error: '找不到帳號' });

    if (existing.data.role === 'admin') {
      const admins = await client.from('service_users').select('id').eq('role', 'admin');
      if (admins.error) throw admins.error;
      if ((admins.data || []).length <= 1) return json(res, 400, { error: '至少要保留一位管理員' });
    }

    const deleted = await client.from('service_users').delete().eq('id', existing.data.id);
    if (deleted.error) throw deleted.error;
    return json(res, 200, { ok: true });
  } catch (error) {
    return json(res, 500, { error: serviceErrorMessage(error, '刪除帳號失敗') });
  }
}

module.exports = handler;
