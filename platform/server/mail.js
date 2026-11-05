import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function initMail(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      sender_id INTEGER NOT NULL,
      sender_username TEXT NOT NULL,
      app_name TEXT NOT NULL,
      recipients_json TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      body_html TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      transactional INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
}

export function createMailService(ctx) {
  const { db, dataDir } = ctx;
  const mailDir = path.join(dataDir, 'mail');
  fs.mkdirSync(mailDir, { recursive: true });

  function send(user, app, msg = {}, transactional = false) {
    const rawTo = msg.to ?? msg.recipients ?? [];
    const toList = (Array.isArray(rawTo) ? rawTo : String(rawTo).split(/[,;]+/))
      .map((r) => (typeof r === 'string' ? r.trim() : r?.email || ''))
      .filter(Boolean);

    if (!toList.length) {
      const err = new Error('At least one recipient email address is required.');
      err.code = 'invalid_recipient';
      err.status = 400;
      throw err;
    }

    const id = `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const subject = String(msg.subject || '(No subject)').slice(0, 500);
    const text = String(msg.text ?? msg.body ?? '');
    const html = String(msg.html ?? '');
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    const now = Date.now();

    db.prepare(`
      INSERT INTO emails (
        id, sender_id, sender_username, app_name, recipients_json,
        subject, body_text, body_html, attachments_json, transactional, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      user?.id || 1,
      user?.username || 'local',
      String(app || 'app'),
      JSON.stringify(toList),
      subject,
      text,
      html,
      JSON.stringify(attachments.map((a) => ({ filename: a.filename, contentType: a.contentType }))),
      transactional ? 1 : 0,
      now
    );

    const record = {
      id,
      from: `${user?.username || 'local'}@${user?.username || 'local'}.localhost`,
      to: toList,
      subject,
      text,
      html,
      transactional,
      attachments,
      created_at: now,
    };
    fs.writeFileSync(path.join(mailDir, `${id}.json`), JSON.stringify(record, null, 2));

    return {
      ok: true,
      id,
      messageId: id,
      sent: toList.length,
      failed: [],
      suppressed: [],
      accepted: toList,
    };
  }

  function list(user, app, options = {}) {
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
    const rows = db.prepare(
      'SELECT * FROM emails WHERE sender_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(user?.id || 1, limit);
    return rows.map((r) => ({
      id: r.id,
      from: `${r.sender_username}@${r.sender_username}.localhost`,
      to: JSON.parse(r.recipients_json || '[]'),
      subject: r.subject,
      text: r.body_text,
      html: r.body_html,
      attachments: JSON.parse(r.attachments_json || '[]'),
      transactional: !!r.transactional,
      created_at: r.created_at,
    }));
  }

  return { send, list };
}

export async function handleMail(ctx, req, res, url, body, user, sendJson) {
  const p = url.pathname;
  if (!p.startsWith('/api/email/') && !p.startsWith('/api/mail/')) return false;
  const app = String(body?.app || url.searchParams.get('app') || 'app');
  const payload = body?.message && typeof body.message === 'object' ? body.message : (body || {});

  try {
    if (p.endsWith('/send')) {
      return sendJson(res, 200, ctx.mail.send(user, app, payload, false));
    }
    if (p.endsWith('/send-transactional') || p.endsWith('/sendTransactional')) {
      return sendJson(res, 200, ctx.mail.send(user, app, payload, true));
    }
    if (p.endsWith('/list')) {
      const items = ctx.mail.list(user, app, body?.options || body || {});
      return sendJson(res, 200, items);
    }
  } catch (err) {
    return sendJson(res, err.status || 400, { code: err.code || 'mail_error', message: err.message });
  }
  return false;
}
