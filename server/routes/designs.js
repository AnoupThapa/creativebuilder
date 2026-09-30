'use strict';
/* Saved designs with per-design access control:
   private    → only the creator (and workspace owner/admins)
   team_view  → everyone in the workspace can open it, only creator/admins edit
   team_edit  → every designer in the workspace can edit it              */
const express = require('express');
const crypto = require('node:crypto');
const { q } = require('../db');
const S = require('../security');
const { effectivePlan } = require('../plans');

const router = express.Router();
const isAdmin = u => S.ROLE_RANK[u.role] >= S.ROLE_RANK.admin;

function canView(u, d) {
  return d && !d.deleted_at && d.workspace_id === u.workspace_id &&
    (d.owner_id === u.id || isAdmin(u) || d.visibility !== 'private');
}
function canEdit(u, d) {
  return canView(u, d) && u.role !== 'viewer' &&
    (d.owner_id === u.id || isAdmin(u) || d.visibility === 'team_edit');
}
function canManage(u, d) {
  return canView(u, d) && (d.owner_id === u.id || isAdmin(u));
}

function load(req) {
  const d = q.get('SELECT * FROM designs WHERE id = ?', String(req.params.id));
  if (!canView(req.user, d)) throw new S.HttpError(404, 'Design not found.');
  return d;
}

function summary(d, u) {
  const owner = q.get('SELECT name FROM users WHERE id = ?', d.owner_id);
  return {
    id: d.id, name: d.name, visibility: d.visibility, thumbnail: d.thumbnail,
    owner_id: d.owner_id, owner_name: owner?.name || '', created_at: d.created_at, updated_at: d.updated_at,
    can_edit: canEdit(u, d), can_manage: canManage(u, d),
  };
}

function cleanData(v) {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length > 64 * 1024) throw new S.HttpError(413, 'Design data is too large.');
  try { JSON.parse(s); } catch { throw new S.HttpError(400, 'Design data is not valid.'); }
  return s;
}
function cleanThumb(v) {
  if (v === undefined || v === null) return v;
  if (typeof v !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > 400 * 1024)
    throw new S.HttpError(400, 'Thumbnail is not valid.');
  return v;
}
const VIS = new Set(['private', 'team_view', 'team_edit']);

router.get('/designs', (req, res) => {
  const u = req.user;
  const rows = isAdmin(u)
    ? q.all('SELECT * FROM designs WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC', u.workspace_id)
    : q.all(`SELECT * FROM designs WHERE workspace_id = ? AND deleted_at IS NULL
             AND (owner_id = ? OR visibility != 'private') ORDER BY updated_at DESC`, u.workspace_id, u.id);
  res.json(rows.map(d => summary(d, u)));
});

router.post('/designs', S.requireRole('designer'), (req, res) => {
  const u = req.user;
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', u.workspace_id);
  const plan = effectivePlan(ws);
  if (plan.max_designs >= 0) {
    const n = q.get('SELECT COUNT(*) n FROM designs WHERE workspace_id = ? AND deleted_at IS NULL', ws.id).n;
    if (n >= plan.max_designs)
      throw new S.HttpError(402, `Your ${plan.name} plan can keep ${plan.max_designs} saved designs. Delete one or upgrade.`);
  }
  let data = '{}', name = 'Untitled design';
  if (req.body.duplicateOf) {
    const src = q.get('SELECT * FROM designs WHERE id = ?', String(req.body.duplicateOf));
    if (!canView(u, src)) throw new S.HttpError(404, 'Design not found.');
    data = src.data; name = (src.name + ' (copy)').slice(0, 100);
    req.body.thumbnail = src.thumbnail;
  }
  if (req.body.name) name = S.str(req.body.name, { field: 'Name', max: 100 }) || name;
  if (req.body.data !== undefined) data = cleanData(req.body.data);
  const id = crypto.randomUUID();
  const now = Date.now();
  q.run(`INSERT INTO designs (id, workspace_id, owner_id, name, data, thumbnail, visibility, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`, id, u.workspace_id, u.id, name, data, cleanThumb(req.body.thumbnail) || null, 'private', now, now);
  S.audit(req, 'design.create', { id });
  res.status(201).json(summary(q.get('SELECT * FROM designs WHERE id = ?', id), u));
});

router.get('/designs/:id', (req, res) => {
  const d = load(req);
  res.json({ ...summary(d, req.user), data: JSON.parse(d.data || '{}') });
});

router.put('/designs/:id', (req, res) => {
  const d = load(req);
  if (!canEdit(req.user, d)) throw new S.HttpError(403, 'You can view this design but not edit it.');
  const name = req.body.name !== undefined ? S.str(req.body.name, { field: 'Name', required: true, max: 100 }) : d.name;
  const data = cleanData(req.body.data) ?? d.data;
  const thumb = req.body.thumbnail !== undefined ? cleanThumb(req.body.thumbnail) : d.thumbnail;
  let vis = d.visibility;
  if (req.body.visibility !== undefined) {
    if (!canManage(req.user, d)) throw new S.HttpError(403, 'Only the creator or an admin can change sharing.');
    if (!VIS.has(req.body.visibility)) throw new S.HttpError(400, 'Unknown sharing option.');
    vis = req.body.visibility;
  }
  q.run('UPDATE designs SET name = ?, data = ?, thumbnail = ?, visibility = ?, updated_at = ? WHERE id = ?',
    name, data, thumb, vis, Date.now(), d.id);
  if (vis !== d.visibility) S.audit(req, 'design.share', { id: d.id, visibility: vis });
  res.json(summary(q.get('SELECT * FROM designs WHERE id = ?', d.id), req.user));
});

router.delete('/designs/:id', (req, res) => {
  const d = load(req);
  if (!canManage(req.user, d)) throw new S.HttpError(403, 'Only the creator or an admin can delete this design.');
  q.run('UPDATE designs SET deleted_at = ? WHERE id = ?', Date.now(), d.id);
  S.audit(req, 'design.delete', { id: d.id });
  res.json({ ok: true });
});

module.exports = { router, canView, canEdit };
