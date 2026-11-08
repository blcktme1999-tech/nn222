const { bcrypt, ensureDefaultAdmin, getJsonBody, getSupabase, json, methodNotAllowed, publicUser } = require('./_lib/service');

async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const debug = [];
  try {
    debug.push('handler-start');
    const client = getSupabase();
    debug.push('supabase-client-ok');
    await ensureDefaultAdmin(client);
    debug.push('ensure-admin-ok');
    const body = await getJsonBody(req);
    debug.push({ bodyType: typeof body, bodyKeys: body && typeof body === 'object' ? Object.keys(body) : [] });
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const result = await client.from('service_users').select('*').eq('username', username).limit(1);
    debug.push({ selectError: result.error?.message || null, count: result.data?.length || 0 });
    if (result.error) throw result.error;
    const user = (result.data || [])[0] || null;
    const passwordOk = Boolean(user && bcrypt.compareSync(password, user.password_hash));
    debug.push({ userFound: Boolean(user), passwordOk, user: user ? publicUser(user) : null });
    json(res, 200, { ok: true, debug });
  } catch (error) {
    debug.push({ caught: error.message || String(error), code: error.code || null, details: error.details || null, hint: error.hint || null });
    json(res, 500, { ok: false, debug });
  }
}

module.exports = handler;
