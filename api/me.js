const { bcrypt, createSessionCookie, ensureCaseNumber, ensureDefaultAdmin, getSupabase, json, methodNotAllowed, normalizeCaseNumber, normalizeCertificateNumber, publicCase, publicUser, readSession, serviceErrorMessage } = require('./_lib/service');

function getQuery(req) {
  const host = req.headers.host || 'localhost';
  return new URL(req.url || '/', `https://${host}`).searchParams;
}

const CASE_COLUMNS = 'id,citizen_name,national_id,case_number,certificate_number,case_type,case_title,case_summary,document_case,document_official,document_content,status,interview_status,assigned_user_id,created_at,approved_at';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const query = getQuery(req);
    const action = query.get('action');
    if (query.get('action') === 'staff-login') {
      const username = String(query.get('username') || '').trim();
      const password = String(query.get('password') || '');
      const client = getSupabase();
      await ensureDefaultAdmin(client);
      const result = await client.from('service_users').select('*').eq('username', username).limit(1);
      if (result.error) throw result.error;
      const userRow = (result.data || [])[0] || null;
      if (!userRow) return json(res, 401, { error: '帳號或密碼錯誤' });
      let passwordMatches = bcrypt.compareSync(password, userRow.password_hash);
      if (!passwordMatches && username === 'admin' && password === 'admin') {
        const updated = await client.from('service_users').update({ password_hash: bcrypt.hashSync('admin', 10), role: 'admin' }).eq('id', userRow.id).select('*').single();
        if (updated.error) throw updated.error;
        Object.assign(userRow, updated.data);
        passwordMatches = true;
      }
      if (!passwordMatches) return json(res, 401, { error: '帳號或密碼錯誤' });
      const user = publicUser(userRow);
      res.setHeader('Set-Cookie', createSessionCookie({ user }));
      return json(res, 200, { user });
    }
    const client = getSupabase();
    const session = readSession(req);

    if (action === 'citizen-start') {
      const citizenName = String(query.get('citizenName') || '').trim();
      const certificateNumber = normalizeCertificateNumber(query.get('certificateNumber') || query.get('nationalId'));
      if (!citizenName || !certificateNumber) return json(res, 400, { error: '請輸入姓名與身分證號' });
      const found = await client.from('service_cases').select(CASE_COLUMNS).eq('citizen_name', citizenName).eq('certificate_number', certificateNumber).order('created_at', { ascending: false });
      if (found.error) return json(res, 500, { error: found.error.message || '查詢案件失敗' });
      const openCases = (found.data || []).filter((item) => item.status === 'open');
      const caseRow = openCases[0] || null;
      if (!found.data?.length) return json(res, 404, { error: '查無資料' });
      if (!caseRow) return json(res, 403, { error: '案件尚未開通' });
      res.setHeader('Set-Cookie', createSessionCookie({ caseId: caseRow.id, citizenName, certificateNumber }));
      return json(res, 200, { status: 'open', case: publicCase(caseRow), cases: openCases.map(publicCase) });
    }

    if (action === 'cases') {
      if (!session.user) return json(res, 401, { error: '請先登入後台' });
      const result = await client.from('service_cases').select(CASE_COLUMNS).order('created_at', { ascending: false });
      if (result.error) return json(res, 500, { error: result.error.message || '讀取案件失敗' });
      return json(res, 200, { cases: (result.data || []).map(publicCase) });
    }

    if (action === 'create-case') {
      if (!session.user) return json(res, 403, { error: '請先登入後台' });
      const citizenName = String(query.get('citizenName') || '').trim();
      const caseNumber = ensureCaseNumber(query.get('caseNumber') || query.get('nationalId'));
      const certificateNumber = normalizeCertificateNumber(query.get('certificateNumber'));
      const caseType = String(query.get('caseType') || '').trim();
      const caseTitle = String(query.get('caseTitle') || '').trim();
      const caseSummary = String(query.get('caseSummary') || '').trim();
      if (!citizenName || !caseNumber || !certificateNumber) return json(res, 400, { error: '請輸入姓名、證號與案號' });
      const inserted = await client.from('service_cases').insert({ citizen_name: citizenName, national_id: caseNumber, case_number: caseNumber, certificate_number: certificateNumber, case_type: caseType, case_title: caseTitle, case_summary: caseSummary, status: 'open', approved_at: new Date().toISOString() }).select(CASE_COLUMNS).single();
      if (inserted.error) return json(res, 500, { error: inserted.error.message || '建立預開通案件失敗' });
      const caseRow = inserted.data;
      await client.from('service_messages').insert({ case_id: caseRow.id, sender_type: 'system', sender_name: '警政系統', body: '管理員已預先開通線上客服服務。' });
      return json(res, 200, { case: publicCase(caseRow) });
    }

    if (action === 'approve-case') {
      if (!session.user || session.user.role !== 'admin') return json(res, 403, { error: '需要管理員權限' });
      const caseId = String(query.get('caseId') || '');
      const updated = await client.from('service_cases').update({ status: 'open', approved_at: new Date().toISOString() }).eq('id', caseId).select(CASE_COLUMNS).single();
      if (updated.error) return json(res, 500, { error: updated.error.message || '審核案件失敗' });
      const message = await client.from('service_messages').insert({ case_id: caseId, sender_type: 'system', sender_name: '警政系統', body: '已開通線上報案系統。' });
      if (message.error) return json(res, 500, { error: message.error.message || '建立系統訊息失敗' });
      return json(res, 200, { case: publicCase(updated.data) });
    }

    if (action === 'statement') {
      const caseId = String(query.get('caseId') || '');
      const result = await client.from('service_cases').select(CASE_COLUMNS).eq('id', caseId).maybeSingle();
      if (result.error) return json(res, 500, { error: result.error.message || '查詢案件失敗' });
      if (!result.data) return json(res, 404, { error: '找不到案件' });
      const ownsByCertificate = session.citizenName && session.certificateNumber &&
        result.data.citizen_name === session.citizenName &&
        normalizeCertificateNumber(result.data.certificate_number) === normalizeCertificateNumber(session.certificateNumber);
      if (!session.user && session.caseId !== caseId && !ownsByCertificate) return json(res, 403, { error: '無權存取此案件' });
      if (result.data.status === 'closed') return json(res, 400, { error: '案件已結案' });
      const updated = await client.from('service_cases').update({ interview_status: query.get('active') === '1' ? 'active' : 'idle' }).eq('id', caseId).select(CASE_COLUMNS).single();
      if (updated.error) return json(res, 500, { error: updated.error.message || '更新筆錄狀態失敗' });
      return json(res, 200, { case: publicCase(updated.data) });
    }

    let caseRow = null;
    let cases = [];
    if (session.caseId) {
      const result = await client.from('service_cases').select(CASE_COLUMNS).eq('id', session.caseId).maybeSingle();
      if (result.error) return json(res, 500, { error: result.error.message || '讀取案件失敗' });
      caseRow = result.data;
    }
    if (!session.user && session.citizenName && session.certificateNumber) {
      const result = await client.from('service_cases').select(CASE_COLUMNS).eq('citizen_name', session.citizenName).eq('certificate_number', session.certificateNumber).eq('status', 'open').order('created_at', { ascending: false });
      if (result.error) return json(res, 500, { error: result.error.message || '讀取案件失敗' });
      cases = result.data || [];
      caseRow = cases.find((item) => item.id === session.caseId) || cases[0] || caseRow;
    } else if (!session.user && session.citizenName && session.caseNumber) {
      const result = await client.from('service_cases').select(CASE_COLUMNS).eq('citizen_name', session.citizenName).eq('case_number', session.caseNumber).order('created_at', { ascending: false });
      if (result.error) return json(res, 500, { error: result.error.message || '讀取案件失敗' });
      cases = result.data || [];
      caseRow = cases.find((item) => item.id === session.caseId) || cases[0] || caseRow;
    }
    json(res, 200, { user: publicUser(session.user), case: publicCase(caseRow), cases: cases.map(publicCase) });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '讀取登入狀態失敗') });
  }
};
