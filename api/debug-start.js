const { getJsonBody, getSupabase, json, methodNotAllowed } = require('./_lib/service');

async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const debug = [];
  try {
    debug.push('handler-start');
    const client = getSupabase();
    debug.push('supabase-client-ok');
    const body = await getJsonBody(req);
    debug.push({ bodyType: typeof body, bodyKeys: body && typeof body === 'object' ? Object.keys(body) : [] });
    const citizenName = String(body.citizenName || 'debug-user').trim();
    const nationalId = String(body.nationalId || `DEBUG${Date.now()}`).trim().toUpperCase();
    const selected = await client.from('service_cases').select('*').eq('citizen_name', citizenName).eq('national_id', nationalId).limit(1);
    debug.push({ selectError: selected.error?.message || null, selectCount: selected.data?.length || 0 });
    if (selected.error) throw selected.error;
    const inserted = await client.from('service_cases').insert({ citizen_name: citizenName, national_id: nationalId, status: 'pending' }).select('*').single();
    debug.push({ insertError: inserted.error?.message || null, insertedId: inserted.data?.id || null });
    if (inserted.error) throw inserted.error;
    json(res, 200, { ok: true, debug });
  } catch (error) {
    debug.push({ caught: error.message || String(error), code: error.code || null, details: error.details || null, hint: error.hint || null });
    json(res, 500, { ok: false, debug });
  }
}

module.exports = handler;
