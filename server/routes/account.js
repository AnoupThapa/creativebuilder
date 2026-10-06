'use strict';
/* Privacy controls: "Download my data" and "Delete my account".
   - Download: a ZIP with everything we hold about the user (and, for the owner,
     the whole business workspace): profile, designs, brand kits, downloads
     history, sessions, activity log, and the uploaded photos/videos/logos.
   - Delete: a member's account is removed (their shared designs stay with the
     team, owned by the workspace owner). The owner deleting their account
     deletes the entire workspace, all members, files, and cancels billing. */
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const config = require('../config');
const { q, tx } = require('../db');
const S = require('../security');

const router = express.Router();
const mediaPath = m => path.join(config.UPLOAD_DIR, String(m.workspace_id), m.id);
const clean = r => { if (!r) return r; const o = { ...r }; delete o.password_hash; delete o.totp_secret; return o; };

router.get('/me/export', async (req, res) => {
  const u = req.user;
  const isOwner = u.role === 'owner';
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', u.workspace_id);
  const users = isOwner ? q.all('SELECT * FROM users WHERE workspace_id = ?', ws.id) : [u];
  const designs = isOwner
    ? q.all('SELECT * FROM designs WHERE workspace_id = ? AND deleted_at IS NULL', ws.id)
    : q.all('SELECT * FROM designs WHERE owner_id = ? AND deleted_at IS NULL', u.id);
  const media = isOwner
    ? q.all('SELECT * FROM media WHERE workspace_id = ?', ws.id)
    : q.all('SELECT * FROM media WHERE owner_id = ?', u.id);

  const zip = new JSZip();
  const data = {
    exported_at: new Date().toISOString(),
    scope: isOwner ? 'whole workspace (you are the owner)' : 'your account',
    account: clean(u),
    workspace: isOwner ? { ...ws } : { id: ws.id, name: ws.name },
    team_members: isOwner ? users.map(x => ({ id: x.id, name: x.name, email: x.email, role: x.role, status: x.status, created_at: x.created_at })) : undefined,
    designs: designs.map(d => ({ id: d.id, name: d.name, visibility: d.visibility, created_at: d.created_at, updated_at: d.updated_at, owner_id: d.owner_id, data: JSON.parse(d.data || '{}') })),
    brand_kits: q.all('SELECT * FROM brand_kits WHERE workspace_id = ?', ws.id),
    downloads: q.all('SELECT platform, kind, quality, plan_code, design_id, created_at FROM exports WHERE ' + (isOwner ? 'workspace_id = ?' : 'user_id = ?') + ' ORDER BY id', isOwner ? ws.id : u.id),
    social_posts: q.all('SELECT id, kind, caption, status, scheduled_at, published_at, created_at FROM social_posts WHERE ' + (isOwner ? 'workspace_id = ?' : 'user_id = ?') + ' ORDER BY id', isOwner ? ws.id : u.id),
    social_accounts: isOwner ? q.all('SELECT platform, name, username, created_at FROM social_accounts WHERE workspace_id = ?', ws.id) : undefined,
    sessions: q.all('SELECT created_at, last_seen, ip, user_agent FROM sessions WHERE user_id = ?', u.id),
    activity_log: q.all('SELECT action, detail, ip, created_at FROM audit_log WHERE user_id = ? ORDER BY id', u.id),
    files: media.map(m => ({ id: m.id, filename: m.filename, type: m.mime, size: m.size, uploaded_at: m.created_at, zip_path: `files/${m.id}-${m.filename}` })),
  };
  zip.file('postgenx-data.json', JSON.stringify(data, null, 2));
  zip.file('README.txt', `PostGenX data export\nCreated: ${data.exported_at}\nScope: ${data.scope}\n\npostgenx-data.json  - your account, designs, brand kits, download history, sessions and activity\nfiles/               - the photos, videos and logos you uploaded\nthumbnails/          - preview images of your designs\n`);
  for (const d of designs) {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(d.thumbnail || '');
    if (m) zip.file(`thumbnails/${d.id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`, Buffer.from(m[2], 'base64'));
  }
  for (const m of media) {
    try { zip.file(`files/${m.id}-${m.filename}`, fs.readFileSync(mediaPath(m))); } catch { /* missing file */ }
  }
  S.audit(req, 'account.data_exported', { designs: designs.length, files: media.length });
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const stamp = new Date().toISOString().slice(0, 10);
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="postgenx-data-${stamp}.zip"`, 'Cache-Control': 'no-store' });
  res.send(buf);
});

function deleteMediaFiles(rows) {
  for (const m of rows) { try { fs.unlinkSync(mediaPath(m)); } catch { /* already gone */ } }
}

router.post('/me/delete', async (req, res) => {
  const u = req.user;
  if (String(req.body.confirm || '') !== 'DELETE') throw new S.HttpError(400, 'Type DELETE to confirm.');
  if (!(await S.verifyPassword(req.body.password, u.password_hash))) throw new S.HttpError(400, 'Password is incorrect.');
  if (u.is_superadmin && q.get('SELECT COUNT(*) n FROM users WHERE is_superadmin = 1 AND status = \'active\'').n <= 1)
    throw new S.HttpError(400, 'You are the only platform admin. Make someone else an admin first.');

  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', u.workspace_id);
  let stripeNote = null;

  if (u.role === 'owner') {
    // cancel any live Stripe subscription immediately
    if (ws.stripe_subscription_id && config.stripe.secretKey) {
      try { await require('stripe')(config.stripe.secretKey).subscriptions.cancel(ws.stripe_subscription_id); }
      catch (e) { stripeNote = e.message; }
    }
    const media = q.all('SELECT * FROM media WHERE workspace_id = ?', ws.id);
    const socialPosts = q.all('SELECT * FROM social_posts WHERE workspace_id = ?', ws.id);
    tx(() => {
      const ids = q.all('SELECT id FROM users WHERE workspace_id = ?', ws.id).map(r => r.id);
      for (const id of ids) {
        q.run('DELETE FROM sessions WHERE user_id = ?', id);
        q.run('DELETE FROM tokens WHERE user_id = ?', id);
        q.run('UPDATE audit_log SET user_id = NULL, ip = NULL WHERE user_id = ?', id);
      }
      q.run("DELETE FROM tokens WHERE type = 'invite' AND json_extract(data, '$.workspace_id') = ?", ws.id);
      q.run('DELETE FROM exports WHERE workspace_id = ?', ws.id);
      q.run('DELETE FROM designs WHERE workspace_id = ?', ws.id);
      q.run('DELETE FROM brand_kits WHERE workspace_id = ?', ws.id);
      q.run('DELETE FROM media WHERE workspace_id = ?', ws.id);
      q.run('DELETE FROM social_post_targets WHERE post_id IN (SELECT id FROM social_posts WHERE workspace_id = ?)', ws.id);
      q.run('DELETE FROM social_posts WHERE workspace_id = ?', ws.id);
      q.run('DELETE FROM social_accounts WHERE workspace_id = ?', ws.id);
      q.run('DELETE FROM oauth_states WHERE workspace_id = ?', ws.id);
      q.run('UPDATE workspaces SET owner_id = NULL WHERE id = ?', ws.id);
      q.run('DELETE FROM users WHERE workspace_id = ?', ws.id);
      q.run('DELETE FROM workspaces WHERE id = ?', ws.id);
      q.run('INSERT INTO audit_log (action, detail, ip, created_at) VALUES (?,?,?,?)', 'account.workspace_deleted',
        JSON.stringify({ workspace: ws.id, members: ids.length, stripe_error: stripeNote }), S.clientIp(req), Date.now());
    });
    deleteMediaFiles(media);
    for (const p of socialPosts) require('../social').deletePostFiles(p);
    try { fs.rmSync(path.join(config.UPLOAD_DIR, String(ws.id)), { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    const ownerId = ws.owner_id;
    const privateDesigns = q.all("SELECT id FROM designs WHERE owner_id = ? AND visibility = 'private'", u.id);
    tx(() => {
      // private drafts are deleted; designs shared with the team stay, now owned by the workspace owner
      q.run("DELETE FROM designs WHERE owner_id = ? AND visibility = 'private'", u.id);
      q.run('UPDATE designs SET owner_id = ? WHERE owner_id = ?', ownerId, u.id);
      q.run('UPDATE media SET owner_id = ? WHERE owner_id = ?', ownerId, u.id);
      q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      q.run('DELETE FROM tokens WHERE user_id = ?', u.id);
      q.run('DELETE FROM exports WHERE user_id = ?', u.id);
      q.run('UPDATE social_posts SET user_id = ? WHERE user_id = ?', ownerId, u.id);
      q.run('UPDATE social_accounts SET connected_by = ? WHERE connected_by = ?', ownerId, u.id);
      q.run('DELETE FROM oauth_states WHERE user_id = ?', u.id);
      q.run('DELETE FROM users WHERE id = ?', u.id);
      q.run('INSERT INTO audit_log (workspace_id, action, detail, ip, created_at) VALUES (?,?,?,?,?)', ws.id, 'account.member_deleted',
        JSON.stringify({ user: u.id, private_designs_deleted: privateDesigns.length }), S.clientIp(req), Date.now());
    });
  }
  // the audit trail no longer points at a person
  q.run('UPDATE audit_log SET user_id = NULL, ip = NULL WHERE user_id = ?', u.id);
  S.setSessionCookie(res, '', 0);
  res.json({ ok: true, workspaceDeleted: u.role === 'owner' });
});

module.exports = { router };
