const { attachmentTooLarge, createSignedUpload, dataUrlToBuffer, getJsonBody, getSupabase, json, methodNotAllowed, publicFile, requireCaseAccess, requireStaff, safeName, serviceErrorMessage, videoStorage } = require('../../_lib/service');

function storedFileName(caseId, originalName) {
  return `${caseId}/${Date.now()}-${safeName(originalName)}`;
}

async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST']);
  try {
    const client = getSupabase();
    const access = await requireCaseAccess(req, res, client, req.query.caseId);
    if (!access) return;

    if (req.method === 'GET') {
      const result = await client.from('service_files').select('*').eq('case_id', req.query.caseId).order('created_at', { ascending: false });
      if (result.error) throw result.error;
      return json(res, 200, { files: (result.data || []).map(publicFile) });
    }

    const body = await getJsonBody(req);
    if (body.action === 'ticket' || body.action === 'complete' || body.action === 'delete') {
      const session = requireStaff(req, res);
      if (!session) return;
      const caseResult = await client.from('service_cases').select('id').eq('id', req.query.caseId).maybeSingle();
      if (caseResult.error) throw caseResult.error;
      if (!caseResult.data) return json(res, 404, { error: '找不到案件' });
      if (body.action === 'ticket') {
        if (attachmentTooLarge(body.size)) return json(res, 413, { error: '單檔上限為 20 MB。' });
        const storedName = storedFileName(req.query.caseId, body.fileName);
        return json(res, 200, await createSignedUpload(client, storedName));
      }
      if (body.action === 'delete') {
        const existing = await client.from('service_files').select('*').eq('id', body.fileId).eq('case_id', req.query.caseId).maybeSingle();
        if (existing.error) throw existing.error;
        if (!existing.data) return json(res, 404, { error: '找不到檔案' });
        const removed = await (await videoStorage(client)).remove([existing.data.stored_name]);
        if (removed.error) throw removed.error;
        const deleted = await client.from('service_files').delete().eq('id', existing.data.id);
        if (deleted.error) throw deleted.error;
        return json(res, 200, { ok: true });
      }
      const storedName = String(body.storedName || '');
      if (!storedName.startsWith(`${req.query.caseId}/`) || storedName.includes('..')) return json(res, 400, { error: '檔案路徑錯誤' });
      if (attachmentTooLarge(body.size)) return json(res, 413, { error: '單檔上限為 20 MB。' });
      const publicResult = (await videoStorage(client)).getPublicUrl(storedName);
      const inserted = await client.from('service_files').insert({
        case_id: req.query.caseId,
        uploaded_by: session.user.displayName || '服務人員',
        original_name: String(body.fileName || 'attachment').slice(0, 255),
        stored_name: storedName,
        mime_type: String(body.mimeType || 'application/octet-stream').slice(0, 255),
        size: Number(body.size),
        kind: 'upload',
        public_url: publicResult.data?.publicUrl || ''
      }).select('*').single();
      if (inserted.error) throw inserted.error;
      return json(res, 200, { file: publicFile(inserted.data) });
    }
    if (access.caseRow.status === 'closed') return json(res, 400, { error: '案件已結案' });
    const parsed = dataUrlToBuffer(body.dataUrl);
    if (!parsed) return json(res, 400, { error: '檔案格式錯誤，請重新上傳' });
    if (parsed.buffer.length > 3 * 1024 * 1024) return json(res, 413, { error: '目前每個附件上限為 3 MiB，請縮小檔案後再上傳。' });

    const originalName = String(body.fileName || 'attachment').slice(0, 255);
    const storedName = `${req.query.caseId}/${Date.now()}-${safeName(originalName)}`;
    const storage = await videoStorage(client);
    const uploaded = await storage.upload(storedName, parsed.buffer, { contentType: parsed.mimeType, upsert: false });
    if (uploaded.error) throw uploaded.error;
    const publicResult = storage.getPublicUrl(storedName);
    const publicUrl = publicResult.data?.publicUrl || '';
    const user = access.session.user;
    const uploadedBy = user?.displayName || access.session.citizenName || access.caseRow.citizen_name || '民眾';
    const inserted = await client.from('service_files').insert({
      case_id: req.query.caseId,
      uploaded_by: uploadedBy,
      original_name: originalName,
      stored_name: storedName,
      mime_type: parsed.mimeType,
      size: parsed.buffer.length,
      kind: body.kind === 'recording' ? 'recording' : 'upload',
      public_url: publicUrl
    }).select('*').single();
    if (inserted.error) throw inserted.error;
    json(res, 200, { file: publicFile(inserted.data) });
  } catch (error) {
    json(res, 500, { error: serviceErrorMessage(error, '檔案處理失敗') });
  }
}

module.exports = handler;
