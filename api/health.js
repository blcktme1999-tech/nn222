const { ensureVideoBucket, getConfig, getSupabase, json, methodNotAllowed, serviceErrorMessage, VIDEO_BUCKET } = require('./_lib/service');

function safeError(error) {
  return {
    name: error?.name || null,
    message: error?.message || String(error || ''),
    code: error?.code || error?.cause?.code || null,
    cause: error?.cause?.message || null
  };
}

function safeSupabaseUrl(value) {
  try {
    const url = new URL(value);
    return {
      valid: url.protocol === 'https:' && url.hostname.endsWith('.supabase.co'),
      origin: url.origin,
      host: url.hostname
    };
  } catch (_error) {
    return { valid: false, origin: null, host: null };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const checks = {
    env: {
      sessionSecret: false,
      supabaseUrl: false,
      supabaseServiceRoleKey: false,
      agoraAppId: false,
      agoraAppCertificate: false
    },
    supabase: {
      url: { valid: false, origin: null, host: null },
      serviceRoleKeyPresent: false
    },
    tables: {},
    storage: {}
  };

  try {
    const config = getConfig();
    checks.env = {
      sessionSecret: Boolean(config.sessionSecret),
      supabaseUrl: Boolean(config.supabaseUrl),
      supabaseServiceRoleKey: Boolean(config.supabaseServiceRoleKey),
      agoraAppId: Boolean(config.agoraAppId),
      agoraAppCertificate: Boolean(config.agoraAppCertificate)
    };
    checks.supabase = {
      url: safeSupabaseUrl(config.supabaseUrl),
      serviceRoleKeyPresent: Boolean(config.supabaseServiceRoleKey)
    };
    const client = getSupabase();
    const tableNames = ['service_users', 'service_cases', 'service_messages', 'service_files'];
    for (const tableName of tableNames) {
      const result = await client.from(tableName).select('id', { count: 'exact', head: true });
      checks.tables[tableName] = result.error ? { ok: false, error: result.error.message } : { ok: true };
    }
    await ensureVideoBucket(client);
    const buckets = await client.storage.listBuckets();
    checks.storage[VIDEO_BUCKET] = buckets.error
      ? { ok: false, error: buckets.error.message }
      : { ok: (buckets.data || []).some((bucket) => bucket.name === VIDEO_BUCKET) };
    json(res, 200, { ok: true, checks });
  } catch (error) {
    json(res, 500, { ok: false, error: serviceErrorMessage(error, 'health check failed'), detail: safeError(error), checks });
  }
};
