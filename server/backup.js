'use strict';
/* Automatic daily backups.
   - Database: a consistent snapshot (SQLite VACUUM INTO), gzipped + checksummed.
   - Uploaded files: copied once into a shared backup media folder (uploads never change,
     so this is incremental).
   - Keeps the last BACKUP_KEEP (default 14) daily snapshots.
   - Optional off-site copy to any S3-compatible storage (Cloudflare R2, Backblaze B2, AWS S3, Wasabi…).
   Restore with:  npm run restore -- latest      Verify with:  npm run backup:verify */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const config = require('./config');

const BACKUP_DIR = path.resolve(config.ROOT, process.env.BACKUP_DIR || path.join(config.DATA_DIR, 'backups'));
const KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || '14', 10));
const S3 = {
  endpoint: (process.env.BACKUP_S3_ENDPOINT || '').replace(/\/$/, ''),
  bucket: process.env.BACKUP_S3_BUCKET || '',
  key: process.env.BACKUP_S3_ACCESS_KEY || '',
  secret: process.env.BACKUP_S3_SECRET_KEY || '',
  region: process.env.BACKUP_S3_REGION || 'auto',
  prefix: (process.env.BACKUP_S3_PREFIX || 'postforge').replace(/^\/|\/$/g, ''),
};
const s3Enabled = () => !!(S3.endpoint && S3.bucket && S3.key && S3.secret);
const sha = d => crypto.createHash('sha256').update(d).digest('hex');

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(n => /^\d{4}-\d{2}-\d{2}_\d{6}(_\d+)?$/.test(n) && fs.existsSync(path.join(BACKUP_DIR, n, 'manifest.json')))
    .sort().reverse()
    .map(n => ({ name: n, dir: path.join(BACKUP_DIR, n), ...JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, n, 'manifest.json'), 'utf8')) }));
}

function copyOrLink(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
}

/* ---------- minimal S3 (AWS Signature V4) PUT ---------- */
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
async function s3Put(key, body, type = 'application/octet-stream') {
  const url = new URL(`${S3.endpoint}/${S3.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amzDate.slice(0, 8);
  const payloadHash = sha(body);
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, 'content-type': type };
  const signed = Object.keys(headers).sort();
  const canonical = ['PUT', url.pathname, '', signed.map(h => `${h}:${headers[h]}\n`).join(''), signed.join(';'), payloadHash].join('\n');
  const scope = `${day}/${S3.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
  const kSig = hmac(hmac(hmac(hmac('AWS4' + S3.secret, day), S3.region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSig).update(toSign).digest('hex');
  const res = await fetch(url, { method: 'PUT', body, headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${S3.key}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${sig}` } });
  if (!res.ok) throw new Error(`S3 upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

let running = null;
async function runBackup(reason = 'scheduled') {
  if (running) return running;
  running = (async () => {
    const { db, q, metaSet } = require('./db');
    const iso = new Date().toISOString();
    let name = `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/g, '')}`;
    let n = 1;
    while (fs.existsSync(path.join(BACKUP_DIR, name + (n > 1 ? '_' + n : '')))) n++;
    if (n > 1) name += '_' + n;
    const dir = path.join(BACKUP_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    const tmpDb = path.join(dir, 'postforge.db');
    db.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
    const gz = zlib.gzipSync(fs.readFileSync(tmpDb), { level: 6 });
    fs.writeFileSync(path.join(dir, 'postforge.db.gz'), gz);
    fs.rmSync(tmpDb, { force: true });

    // media: copy files not yet in the backup media store
    const mediaStore = path.join(BACKUP_DIR, 'media');
    const media = q.all('SELECT id, workspace_id FROM media');
    const fresh = [];
    for (const m of media) {
      const src = path.join(config.UPLOAD_DIR, String(m.workspace_id), m.id);
      const dst = path.join(mediaStore, String(m.workspace_id), m.id);
      if (fs.existsSync(src) && !fs.existsSync(dst)) { copyOrLink(src, dst); fresh.push({ src: dst, key: `${m.workspace_id}/${m.id}` }); }
    }
    // files waiting to be posted to social media
    const socialDir = path.join(config.DATA_DIR, 'social');
    if (fs.existsSync(socialDir)) {
      for (const f of fs.readdirSync(socialDir)) {
        const dst = path.join(mediaStore, '_social', f);
        if (!fs.existsSync(dst)) { copyOrLink(path.join(socialDir, f), dst); fresh.push({ src: dst, key: `_social/${f}` }); }
      }
    }
    const manifest = {
      created_at: Date.now(), reason, db_gz_bytes: gz.length, db_sha256: sha(gz),
      counts: {
        users: q.get('SELECT COUNT(*) n FROM users').n, workspaces: q.get('SELECT COUNT(*) n FROM workspaces').n,
        designs: q.get('SELECT COUNT(*) n FROM designs').n, media: media.length,
      },
      media_files_new: fresh.length, offsite: s3Enabled() ? 'pending' : 'not configured',
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    if (s3Enabled()) {
      try {
        await s3Put(`${S3.prefix}/db/${name}/postforge.db.gz`, gz, 'application/gzip');
        for (const f of fresh) await s3Put(`${S3.prefix}/media/${f.key}`, fs.readFileSync(f.src));
        await s3Put(`${S3.prefix}/db/${name}/manifest.json`, Buffer.from(JSON.stringify(manifest)), 'application/json');
        manifest.offsite = 'uploaded';
      } catch (e) {
        manifest.offsite = 'failed: ' + e.message;
        console.error('[backup] off-site copy failed:', e.message);
      }
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }

    for (const old of listBackups().slice(KEEP)) fs.rmSync(old.dir, { recursive: true, force: true });
    metaSet('last_backup', manifest.created_at);
    if (process.env.NODE_ENV !== 'test') console.log(`[backup] ${name} done (${(gz.length / 1024).toFixed(0)} KB db, ${fresh.length} new files, off-site: ${manifest.offsite})`);
    return { name, dir, ...manifest };
  })();
  try { return await running; } finally { running = null; }
}

function schedule() {
  if (process.env.BACKUP_ENABLED === 'false' || process.env.NODE_ENV === 'test') return;
  const { metaGet } = require('./db');
  const check = () => {
    const last = parseInt(metaGet('last_backup') || '0', 10);
    if (Date.now() - last > 24 * 3600 * 1000) runBackup('scheduled').catch(e => console.error('[backup] failed:', e));
  };
  setTimeout(check, 30 * 1000).unref();
  setInterval(check, 3600 * 1000).unref();
}

function findBackup(name) {
  const all = listBackups();
  return !name || name === 'latest' ? all[0] : all.find(x => x.name === name);
}

/* Restore a backup into a data folder (scripts/restore.js and the verification check) */
function restoreInto(backup, dataDir) {
  const b = typeof backup === 'string' ? findBackup(backup) : backup;
  if (!b) throw new Error('Backup not found.');
  const gz = fs.readFileSync(path.join(b.dir, 'postforge.db.gz'));
  if (b.db_sha256 && sha(gz) !== b.db_sha256) throw new Error('Backup file is corrupted (checksum mismatch).');
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const target = path.join(dataDir, 'postforge.db');
  if (fs.existsSync(target)) fs.renameSync(target, `${target}.before-restore-${Date.now()}`);
  for (const ext of ['-wal', '-shm']) fs.rmSync(target + ext, { force: true });
  fs.writeFileSync(target, zlib.gunzipSync(gz));
  const mediaStore = path.join(BACKUP_DIR, 'media');
  let restored = 0;
  if (fs.existsSync(mediaStore)) {
    for (const ws of fs.readdirSync(mediaStore)) {
      for (const f of fs.readdirSync(path.join(mediaStore, ws))) {
        const dst = ws === '_social' ? path.join(dataDir, 'social', f) : path.join(dataDir, 'uploads', ws, f);
        if (!fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(mediaStore, ws, f), dst); restored++; }
      }
    }
  }
  return { backup: b.name, db: target, filesRestored: restored };
}

/* Restore into a throw-away folder and check everything is there (the "restore test") */
function verifyBackup(name = 'latest') {
  const os = require('node:os');
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-verify-'));
  try {
    const b = findBackup(name);
    if (!b) throw new Error('No backups found.');
    const r = restoreInto(b, tmp);
    const vdb = new DatabaseSync(r.db, { readOnly: true });
    const integrity = vdb.prepare('PRAGMA integrity_check').get().integrity_check;
    const one = sql => vdb.prepare(sql).get().n;
    const counts = {
      users: one('SELECT COUNT(*) n FROM users'), workspaces: one('SELECT COUNT(*) n FROM workspaces'),
      designs: one('SELECT COUNT(*) n FROM designs'), media: one('SELECT COUNT(*) n FROM media'),
    };
    const missing = vdb.prepare('SELECT id, workspace_id FROM media').all()
      .filter(m => !fs.existsSync(path.join(tmp, 'uploads', String(m.workspace_id), m.id))).length;
    vdb.close();
    const ok = integrity === 'ok' && missing === 0 && Object.keys(b.counts).every(k => counts[k] === b.counts[k]);
    return { ok, backup: b.name, integrity, counts, expected: b.counts, missingFiles: missing, checkedAt: Date.now() };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { runBackup, schedule, listBackups, restoreInto, verifyBackup, BACKUP_DIR, s3Enabled };
