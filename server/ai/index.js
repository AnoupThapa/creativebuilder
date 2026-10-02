'use strict';
/* AI studio engine: templates, credits, daily budget, background job queue, results → editor. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { q, tx, metaGet, metaSet } = require('../db');
const { effectivePlan, localParts, storageUsed } = require('../plans');
const providers = require('./providers');
const { buildPrompt } = require('./prompts');
const { INDUSTRIES, TEMPLATES } = require('./templates');

const AI_DIR = path.join(config.DATA_DIR, 'ai');
fs.mkdirSync(AI_DIR, { recursive: true });
const DAY = 86400000;
const ASPECTS = ['4:5', '1:1', '9:16', '16:9'];
const PLATFORM_FOR = { '4:5': 'ig_portrait', '1:1': 'ig_post', '9:16': 'ig_story', '16:9': 'yt_thumb' };

class HttpErr extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

/* ---------- templates (seeded once; admins can edit wording later) ---------- */
function seedTemplates() {
  const now = Date.now();
  TEMPLATES.forEach((t, i) => {
    if (q.get('SELECT id FROM ai_templates WHERE key = ?', t.key)) return;
    q.run(`INSERT INTO ai_templates (key, industry, kind, name, description, emoji, prompt, needs_photo, text_space, setting, active, sort, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`, t.key, t.industry, t.kind, t.name, t.description, t.emoji, t.prompt, t.needs_photo, t.text_space, t.setting || '', i, now);
  });
}
seedTemplates();
const templates = (all = false) => q.all(`SELECT * FROM ai_templates ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`);

/* ---------- switches ---------- */
const enabled = () => metaGet('ai_enabled') !== '0';
const dailyBudget = () => { const v = parseFloat(metaGet('ai_daily_budget') || ''); return Number.isFinite(v) && v >= 0 ? v : config.ai.dailyBudgetUsd; };
function spentToday() {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  return q.get("SELECT COALESCE(SUM(cost_usd),0) s FROM ai_jobs WHERE created_at >= ? AND status != 'failed'", start.getTime()).s;
}

/* ---------- credits ---------- */
function creditStatus(user) {
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', user.workspace_id);
  const plan = effectivePlan(ws);
  const topup = ws.ai_topup_credits || 0;
  if (plan.ai_credits_monthly > 0) {
    const month = localParts(user.timezone).month;
    const used = q.get("SELECT COALESCE(SUM(credits - credits_topup),0) n FROM ai_jobs WHERE workspace_id = ? AND local_month = ? AND status != 'failed'", ws.id, month).n;
    const included = plan.ai_credits_monthly * Math.max(1, ws.seats);
    const planLeft = Math.max(0, included - used);
    return { period: 'month', included, used, planLeft, topup, left: planLeft + topup, plan: plan.code, label: `${planLeft + topup} AI credits left this month` };
  }
  const used = q.get("SELECT COALESCE(SUM(credits - credits_topup),0) n FROM ai_jobs WHERE user_id = ? AND status != 'failed'", user.id).n;
  const included = plan.ai_credits_lifetime || 0;
  const planLeft = Math.max(0, included - used);
  return { period: 'lifetime', included, used, planLeft, topup, left: planLeft + topup, plan: plan.code, label: `${planLeft + topup} free AI image${planLeft + topup === 1 ? '' : 's'} left` };
}

function addTopup(workspaceId, credits) {
  q.run('UPDATE workspaces SET ai_topup_credits = ai_topup_credits + ? WHERE id = ?', credits, workspaceId);
}

/* ---------- jobs ---------- */
const queue = [];
let running = 0;

function jobDir(id) { return path.join(AI_DIR, id); }
function publicJob(j) {
  return {
    id: j.id, status: j.status, template: j.template_key, aspect: j.aspect, count: j.count, credits: j.credits,
    outputs: JSON.parse(j.outputs || '[]').map((f, i) => ({ n: i, url: `/api/ai/out/${j.id}/${i}` })),
    error: j.error ? j.error.split(' || ')[0] : '', created_at: j.created_at, finished_at: j.finished_at,
    inputs: (() => { try { const x = JSON.parse(j.inputs); return { product: x.product, price: x.price }; } catch { return {}; } })(),
    demo: j.provider === 'demo',
  };
}

function createJob(user, { templateKey, input, photo, aspect, count }) {
  if (!enabled()) throw new HttpErr(503, 'AI studio is paused for maintenance. Please try again later.');
  if (user.role === 'viewer') throw new HttpErr(403, 'Viewers can look at designs but not create AI images.');
  const tpl = q.get('SELECT * FROM ai_templates WHERE key = ? AND active = 1', String(templateKey || ''));
  if (!tpl) throw new HttpErr(400, 'Pick a style first.');
  if (tpl.needs_photo && !photo) throw new HttpErr(400, `“${tpl.name}” needs a real photo of your product, so the picture shows exactly what you sell. Add a photo or a product link.`);
  if (!photo && !String(input.product || '').trim()) throw new HttpErr(400, 'Add a product photo, a link, or at least the product name.');
  aspect = ASPECTS.includes(aspect) ? aspect : '4:5';
  count = Math.min(2, Math.max(1, parseInt(count, 10) || 1));

  // fair use: 2 jobs at a time and 30 an hour per person
  const busy = q.get("SELECT COUNT(*) n FROM ai_jobs WHERE user_id = ? AND status IN ('queued','running')", user.id).n;
  if (busy >= 2) throw new HttpErr(429, 'You already have 2 AI images being made — wait for them to finish.');
  const hour = q.get('SELECT COUNT(*) n FROM ai_jobs WHERE user_id = ? AND created_at > ?', user.id, Date.now() - 3600000).n;
  if (hour >= 30) throw new HttpErr(429, 'That’s a lot of AI images in one hour — please take a short break and try again.');

  const provider = providers.active();
  const estimate = providers.COST[provider] * count;
  if (spentToday() + estimate > dailyBudget()) throw new HttpErr(503, 'AI studio has reached today’s limit. Please try again tomorrow.', { code: 'ai_budget' });

  const prompt = buildPrompt(tpl, input, { hasPhoto: !!photo, aspect });
  const id = crypto.randomBytes(12).toString('hex');
  tx(() => {
    const st = creditStatus(user);
    if (st.left < count) {
      throw new HttpErr(402, st.period === 'lifetime'
        ? `You’ve used your ${st.included} free AI images. Upgrade to get AI images every month.`
        : `Not enough AI credits (${st.left} left, ${count} needed). Buy a credit pack or wait until next month.`, { code: 'ai_credits' });
    }
    const fromPlan = Math.min(count, st.planLeft), fromTopup = count - fromPlan;
    if (fromTopup > 0) q.run('UPDATE workspaces SET ai_topup_credits = ai_topup_credits - ? WHERE id = ?', fromTopup, user.workspace_id);
    q.run(`INSERT INTO ai_jobs (id, user_id, workspace_id, template_key, kind, status, provider, model, inputs, prompt, aspect, count, credits, credits_topup, local_month, cost_usd, created_at)
           VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?)`,
      id, user.id, user.workspace_id, tpl.key, 'image', provider, '', JSON.stringify(input), prompt, aspect, count, count, fromTopup,
      localParts(user.timezone).month, estimate, Date.now());
  });
  if (photo) {
    fs.mkdirSync(jobDir(id), { recursive: true });
    fs.writeFileSync(path.join(jobDir(id), 'input'), photo.buffer, { mode: 0o600 });
    fs.writeFileSync(path.join(jobDir(id), 'input.mime'), photo.mime);
  }
  queue.push(id);
  pump();
  return q.get('SELECT * FROM ai_jobs WHERE id = ?', id);
}

function fail(job, err) {
  tx(() => {
    q.run("UPDATE ai_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
      `${err.message || 'Failed'}${err.detail ? ' || ' + err.detail : ''}`.slice(0, 900), Date.now(), job.id);
    if (job.credits_topup > 0) addTopup(job.workspace_id, job.credits_topup); // plan credits come back automatically (failed jobs don't count)
  });
}

async function run(id) {
  const job = q.get('SELECT * FROM ai_jobs WHERE id = ?', id);
  if (!job || job.status !== 'queued') return;
  q.run("UPDATE ai_jobs SET status = 'running' WHERE id = ?", id);
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    let photo = null;
    if (fs.existsSync(path.join(dir, 'input'))) photo = { buffer: fs.readFileSync(path.join(dir, 'input')), mime: fs.readFileSync(path.join(dir, 'input.mime'), 'utf8') };
    const r = await providers.generate({ prompt: job.prompt, photo, aspect: job.aspect, n: job.count, tmpDir: dir, provider: job.provider });
    const files = r.images.map((buf, i) => {
      const ext = buf[0] === 0xff ? 'jpg' : buf.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : 'png';
      const f = `out-${i}.${ext}`;
      fs.writeFileSync(path.join(dir, f), buf, { mode: 0o600 });
      return f;
    });
    // fewer images than paid for? give the difference back
    const missing = job.count - files.length;
    q.run("UPDATE ai_jobs SET status = 'done', outputs = ?, model = ?, cost_usd = ?, credits = credits - ?, finished_at = ? WHERE id = ?",
      JSON.stringify(files), r.model, r.costUsd, Math.max(0, missing), Date.now(), id);
  } catch (e) {
    console.error('[ai]', id, e.reason || '', e.message, e.detail || '');
    fail(job, e.reason ? e : new providers.AiError('The AI could not make this image. Please try again.', 'failed', e.message));
  } finally {
    fs.rm(path.join(dir, 'input'), { force: true }, () => {});
  }
}

function pump() {
  while (running < config.ai.jobs && queue.length) {
    const id = queue.shift();
    running++;
    run(id).finally(() => { running--; pump(); });
  }
}

/* after a restart, unfinished jobs are cancelled and refunded */
for (const j of q.all("SELECT * FROM ai_jobs WHERE status IN ('queued','running')")) fail(j, new Error('The server restarted while making this image — your credits were returned. Please try again.'));

/* keep generated files 30 days */
setInterval(() => {
  const old = q.all('SELECT id FROM ai_jobs WHERE created_at < ? AND outputs != ?', Date.now() - 30 * DAY, '[]');
  for (const j of old) { fs.rm(jobDir(j.id), { recursive: true, force: true }, () => {}); q.run("UPDATE ai_jobs SET outputs = '[]' WHERE id = ?", j.id); }
}, 6 * 3600 * 1000).unref();

function outputFile(user, id, n) {
  const j = q.get('SELECT * FROM ai_jobs WHERE id = ? AND workspace_id = ?', String(id), user.workspace_id);
  if (!j) return null;
  const f = JSON.parse(j.outputs || '[]')[parseInt(n, 10)];
  return f ? { path: path.join(jobDir(j.id), f), job: j, file: f } : null;
}

/* Put a result into the media library and open it as a new design */
function toDesign(user, id, n) {
  const out = outputFile(user, id, n);
  if (!out || !fs.existsSync(out.path)) throw new HttpErr(404, 'This AI image is no longer available.');
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', user.workspace_id);
  const plan = effectivePlan(ws);
  const buf = fs.readFileSync(out.path);
  if (storageUsed(ws.id) + buf.length > plan.storage_mb * 1024 * 1024) throw new HttpErr(413, 'Your storage is full. Delete old media or upgrade your plan.');
  if (plan.max_designs >= 0) {
    const nDesigns = q.get('SELECT COUNT(*) n FROM designs WHERE workspace_id = ? AND deleted_at IS NULL', ws.id).n;
    if (nDesigns >= plan.max_designs) throw new HttpErr(402, `Your ${plan.name} plan can keep ${plan.max_designs} saved designs. Delete one or upgrade.`);
  }
  const mime = out.file.endsWith('.jpg') ? 'image/jpeg' : out.file.endsWith('.webp') ? 'image/webp' : 'image/png';
  const mediaId = crypto.randomUUID();
  const dir = path.join(config.UPLOAD_DIR, String(ws.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, mediaId), buf, { mode: 0o600 });
  let input = {}; try { input = JSON.parse(out.job.inputs); } catch {}
  const name = `AI · ${(input.product || 'Product').slice(0, 60)}`;
  const now = Date.now();
  q.run('INSERT INTO media (id, workspace_id, owner_id, filename, mime, kind, size, created_at) VALUES (?,?,?,?,?,?,?,?)',
    mediaId, ws.id, user.id, `ai-${out.job.id.slice(0, 8)}-${n}.${out.file.split('.').pop()}`, mime, 'image', buf.length, now);
  const data = {
    v: 1, contentType: 'promo', platformKey: PLATFORM_FOR[out.job.aspect] || 'ig_portrait',
    mediaId, mediaName: name, mediaKind: 'image', mediaFit: 'auto', fitBg: 'blur',
    headline: (input.product || '').slice(0, 60) || 'New Arrival', subheadline: '', price: (input.price || '').slice(0, 30), badge: '',
  };
  const designId = crypto.randomUUID();
  q.run(`INSERT INTO designs (id, workspace_id, owner_id, name, data, visibility, created_at, updated_at) VALUES (?,?,?,?,?,'private',?,?)`,
    designId, ws.id, user.id, name.slice(0, 100), JSON.stringify(data), now, now);
  return { designId, mediaId };
}

function stats() {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
  const agg = since => q.get(`SELECT COUNT(*) jobs, COALESCE(SUM(CASE WHEN status='done' THEN credits END),0) images,
    COALESCE(SUM(CASE WHEN status!='failed' THEN cost_usd END),0) cost, COALESCE(SUM(status='failed'),0) failed FROM ai_jobs WHERE created_at >= ?`, since);
  return {
    enabled: enabled(), dailyBudget: dailyBudget(), provider: providers.active(),
    keys: { gemini: !!config.ai.geminiKey, openai: !!config.ai.openaiKey },
    models: { gemini: config.ai.geminiImageModel, openai: config.ai.openaiImageModel },
    today: agg(start.getTime()), month: agg(month.getTime()),
    recentErrors: q.all("SELECT id, template_key, provider, error, created_at FROM ai_jobs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10"),
    queue: { running, waiting: queue.length },
  };
}

module.exports = {
  INDUSTRIES, ASPECTS, templates, creditStatus, addTopup, createJob, publicJob, outputFile, toDesign, stats,
  enabled, setEnabled: v => metaSet('ai_enabled', v ? '1' : '0'), setDailyBudget: v => metaSet('ai_daily_budget', String(v)),
  HttpErr, _queueIdle: () => running === 0 && queue.length === 0,
};
