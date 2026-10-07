'use strict';
/* AI studio engine: templates, credits, daily budget, background job queue, results → editor. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { q, tx, metaGet, metaSet } = require('../db');
const { effectivePlan, localParts, storageUsed } = require('../plans');
require('./keys'); // keys saved by the admin take effect before anything else
const providers = require('./providers');
const { buildPrompt, buildVideoPrompt, VIDEO_NEGATIVE, buildPortraitPrompt, buildModelPrompt, buildPresenterPrompt, PRESENTER_NEGATIVE } = require('./prompts');
const characters = require('./characters');
const script = require('./script');
const videogen = require('./videogen');
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
/* v2 wording (stricter "no lettering"): refresh styles an admin has not edited since seeding */
if (metaGet('ai_templates_v') !== '2') {
  const firstSeed = q.get('SELECT MIN(updated_at) t FROM ai_templates').t;
  for (const t of TEMPLATES) {
    q.run('UPDATE ai_templates SET prompt = ?, description = ?, setting = ? WHERE key = ? AND updated_at = ?', t.prompt, t.description, t.setting || '', t.key, firstSeed);
  }
  metaSet('ai_templates_v', '2');
}
const templates = (all = false) => q.all(`SELECT * FROM ai_templates ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`);

/* ---------- switches ---------- */
const enabled = () => metaGet('ai_enabled') !== '0';
const qualityCheck = () => { const v = metaGet('ai_quality_check'); return v == null ? config.ai.qualityCheck : v === '1'; };
const dailyBudget = () => { const v = parseFloat(metaGet('ai_daily_budget') || ''); return Number.isFinite(v) && v >= 0 ? v : config.ai.dailyBudgetUsd; };
function spentToday() {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  return q.get("SELECT COALESCE(SUM(cost_usd),0) s FROM ai_jobs WHERE created_at >= ?", start.getTime()).s;
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
    outputs: JSON.parse(j.outputs || '[]').map((f, i) => ({ n: i, url: `/api/ai/out/${j.id}/${i}`,
      ...(j.kind === 'video' ? { poster: `/api/ai/out/${j.id}/${i}?poster=1` } : {}) })),
    error: j.error ? j.error.split(' || ')[0] : '', created_at: j.created_at, finished_at: j.finished_at,
    inputs: (() => { try { const x = JSON.parse(j.inputs); return { product: x.product, price: x.price, character: x.character, look: x.look, parts: x.parts, language: x.language }; } catch { return {}; } })(),
    demo: j.provider === 'demo', kind: j.kind,
    seconds: (() => { try { return JSON.parse(j.inputs).seconds || 0; } catch { return 0; } })(),
  };
}

// fair use: 2 jobs at a time and 30 an hour per person
function fairUse(user) {
  const busy = q.get("SELECT COUNT(*) n FROM ai_jobs WHERE user_id = ? AND status IN ('queued','running')", user.id).n;
  if (busy >= 2) throw new HttpErr(429, 'You already have 2 AI jobs being made — wait for them to finish.');
  const hour = q.get('SELECT COUNT(*) n FROM ai_jobs WHERE user_id = ? AND created_at > ?', user.id, Date.now() - 3600000).n;
  if (hour >= 30) throw new HttpErr(429, 'That’s a lot of AI work in one hour — please take a short break and try again.');
}
/* take credits (inside a transaction): plan credits first, then bought packs → how many came from packs */
function charge(user, n) {
  const st = creditStatus(user);
  if (st.left < n) {
    throw new HttpErr(402, st.period === 'lifetime'
      ? `You’ve used your ${st.included} free AI images. Upgrade to get AI images every month.`
      : `Not enough AI credits (${st.left} left, ${n} needed). Buy a credit pack or wait until next month.`, { code: 'ai_credits' });
  }
  const fromTopup = n - Math.min(n, st.planLeft);
  if (fromTopup > 0) q.run('UPDATE workspaces SET ai_topup_credits = ai_topup_credits - ? WHERE id = ?', fromTopup, user.workspace_id);
  return fromTopup;
}

function createJob(user, { templateKey, input, photo, aspect, count }) {
  if (!enabled()) throw new HttpErr(503, 'AI studio is paused for maintenance. Please try again later.');
  if (user.role === 'viewer') throw new HttpErr(403, 'Viewers can look at designs but not create AI images.');
  const tpl = q.get("SELECT * FROM ai_templates WHERE key = ? AND active = 1 AND kind = 'image'", String(templateKey || ''));
  if (!tpl) throw new HttpErr(400, 'Pick a style first.');
  if (tpl.needs_photo && !photo) throw new HttpErr(400, `“${tpl.name}” needs a real photo of your product, so the picture shows exactly what you sell. Add a photo or a product link.`);
  if (!photo && !String(input.product || '').trim()) throw new HttpErr(400, 'Add a product photo, a link, or at least the product name.');
  aspect = ASPECTS.includes(aspect) ? aspect : '4:5';
  count = Math.min(2, Math.max(1, parseInt(count, 10) || 1));

  fairUse(user);

  const provider = providers.active();
  const estimate = providers.COST[provider] * count;
  if (spentToday() + estimate > dailyBudget()) throw new HttpErr(503, 'AI studio has reached today’s limit. Please try again tomorrow.', { code: 'ai_budget' });

  const prompt = buildPrompt(tpl, input, { hasPhoto: !!photo, aspect });
  const id = crypto.randomBytes(12).toString('hex');
  tx(() => {
    const fromTopup = charge(user, count);
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

/* spent = what the AI service actually charged us before it went wrong (kept for the daily budget) */
function fail(job, err, spent = 0) {
  tx(() => {
    q.run("UPDATE ai_jobs SET status = 'failed', remote_op = '', cost_usd = ?, error = ?, finished_at = ? WHERE id = ?",
      spent, `${err.message || 'Failed'}${err.detail ? ' || ' + err.detail : ''}`.slice(0, 900), Date.now(), job.id);
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
    // AI model photos: the character's reference portrait goes along so the same face appears every time
    const isModel = job.template_key.startsWith('model:');
    let refs = [], cost = 0;
    if (isModel) {
      const ch = characters.byKey(job.template_key.split(':')[1]);
      if (!ch) throw new providers.AiError('That AI model is no longer available. Please pick another one.', 'failed');
      const pr = await portrait(ch, job.provider, dir);
      cost += pr.cost; refs = [pr.ref];
    }
    const r = await providers.generate({ prompt: job.prompt, photo, refs, aspect: job.aspect, n: job.count, tmpDir: dir, provider: job.provider });
    cost += r.costUsd; let redone = 0, rejected = 0;
    // quality check: no lettering, product sharp & unchanged — redo a failing image once, then drop it (refunded)
    const images = [];
    const checking = qualityCheck() && job.provider !== 'demo';
    for (let img of r.images) {
      if (checking) {
        cost += providers.CHECK_COST[job.provider] || 0;
        let v = await providers.checkImage({ image: img, photo, provider: job.provider, person: isModel });
        if (v && !v.ok) {
          console.warn('[ai-check]', id, 'rejected:', v.problems.join(', '), v.notes);
          redone++;
          try {
            const again = await providers.generate({ prompt: job.prompt, photo, refs, aspect: job.aspect, n: 1, tmpDir: dir, provider: job.provider });
            cost += again.costUsd + (providers.CHECK_COST[job.provider] || 0);
            img = again.images[0];
            v = await providers.checkImage({ image: img, photo, provider: job.provider, person: isModel });
          } catch (e) { v = { ok: false, problems: ['retry failed'] }; }
          if (v && !v.ok) { rejected++; console.warn('[ai-check]', id, 'still rejected:', v.problems.join(', ')); continue; }
        }
      }
      images.push(img);
    }
    if (!images.length) {
      q.run('UPDATE ai_jobs SET redone = ?, rejected = ? WHERE id = ?', redone, rejected, id);
      throw Object.assign(new providers.AiError('We couldn’t get a clean picture this time (the AI kept adding writing or changing your product), so your credits were returned. Try another style or a clearer, front-facing photo.', 'quality', 'quality check rejected all images'), { spent: cost });
    }
    const files = images.map((buf, i) => {
      const ext = buf[0] === 0xff ? 'jpg' : buf.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : 'png';
      const f = `out-${i}.${ext}`;
      fs.writeFileSync(path.join(dir, f), buf, { mode: 0o600 });
      return f;
    });
    // fewer images than paid for? give the difference back
    const missing = job.count - files.length;
    tx(() => {
      const fromTopup = Math.min(Math.max(0, missing), job.credits_topup);
      if (fromTopup > 0) addTopup(job.workspace_id, fromTopup);
      q.run("UPDATE ai_jobs SET status = 'done', outputs = ?, model = ?, cost_usd = ?, credits = credits - ?, credits_topup = credits_topup - ?, redone = ?, rejected = ?, finished_at = ? WHERE id = ?",
        JSON.stringify(files), r.model, cost, Math.max(0, missing), fromTopup, redone, rejected, Date.now(), id);
    });
  } catch (e) {
    console.error('[ai]', id, e.reason || '', e.message, e.detail || '');
    fail(job, e.reason ? e : new providers.AiError('The AI could not make this image. Please try again.', 'failed', e.message), e.spent || 0);
  } finally {
    fs.rm(path.join(dir, 'input'), { force: true }, () => {});
  }
}

/* ---------- AI models: reference portraits + jobs ---------- */
const CHAR_DIR = path.join(AI_DIR, 'characters');
const portraitBusy = new Map();
/* One photoreal portrait per character and AI service, made the first time it's needed and then reused.
   Demo mode uses the drawing from the picker. */
async function portrait(ch, provider, tmpDir) {
  if (provider === 'demo') return { ref: { buffer: fs.readFileSync(path.join(config.ROOT, 'public', 'img', 'characters', `${ch.key}.png`)), mime: 'image/png' }, cost: 0 };
  const file = path.join(CHAR_DIR, `${ch.key}-${provider}.png`);
  if (fs.existsSync(file)) return { ref: { buffer: fs.readFileSync(file), mime: 'image/png' }, cost: 0 };
  if (!portraitBusy.has(file)) {
    portraitBusy.set(file, (async () => {
      const r = await providers.generate({ prompt: buildPortraitPrompt(ch), aspect: '4:5', n: 1, tmpDir, provider });
      fs.mkdirSync(CHAR_DIR, { recursive: true });
      fs.writeFileSync(file, r.images[0]);
      return r.costUsd;
    })().finally(() => setTimeout(() => portraitBusy.delete(file), 1000)));
    const cost = await portraitBusy.get(file);
    return { ref: { buffer: fs.readFileSync(file), mime: 'image/png' }, cost };
  }
  await portraitBusy.get(file);
  return { ref: { buffer: fs.readFileSync(file), mime: 'image/png' }, cost: 0 };
}
function characterPortraitUrl(key) {
  const p = providers.active();
  return p !== 'demo' && fs.existsSync(path.join(CHAR_DIR, `${key}-${p}.png`)) ? `/api/ai/characters/${key}/portrait` : null;
}

/* photo of an AI model with the customer's product (needs a real product photo) */
function createModelJob(user, { character, action, look, input, photo, aspect, count }) {
  if (!enabled()) throw new HttpErr(503, 'AI studio is paused for maintenance. Please try again later.');
  if (user.role === 'viewer') throw new HttpErr(403, 'Viewers can look at designs but not create AI images.');
  const ch = characters.byKey(String(character || ''));
  if (!ch) throw new HttpErr(400, 'Pick an AI model first.');
  const act = characters.ACTIONS[action] || characters.ACTIONS.hold;
  const lk = characters.LOOKS[look] || characters.LOOKS.studio;
  if (!photo) throw new HttpErr(400, 'Add a photo of your product — the AI model shows your real product, so it needs a picture of it.');
  aspect = ASPECTS.includes(aspect) ? aspect : '4:5';
  count = Math.min(2, Math.max(1, parseInt(count, 10) || 1));
  fairUse(user);
  const provider = providers.active();
  const estimate = providers.COST[provider] * (count + 1);
  if (spentToday() + estimate > dailyBudget()) throw new HttpErr(503, 'AI studio has reached today’s limit. Please try again tomorrow.', { code: 'ai_budget' });
  const prompt = buildModelPrompt(ch, act, lk, input, { aspect, hasPortrait: true });
  const id = crypto.randomBytes(12).toString('hex');
  tx(() => {
    const fromTopup = charge(user, count);
    q.run(`INSERT INTO ai_jobs (id, user_id, workspace_id, template_key, kind, status, provider, model, inputs, prompt, aspect, count, credits, credits_topup, local_month, cost_usd, created_at)
           VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?)`,
      id, user.id, user.workspace_id, `model:${ch.key}`, 'image', provider, '', JSON.stringify({ ...input, character: ch.key, action: action in characters.ACTIONS ? action : 'hold', look: look in characters.LOOKS ? look : 'studio' }),
      prompt, aspect, count, count, fromTopup, localParts(user.timezone).month, estimate, Date.now());
  });
  fs.mkdirSync(jobDir(id), { recursive: true });
  fs.writeFileSync(path.join(jobDir(id), 'input'), photo.buffer, { mode: 0o600 });
  fs.writeFileSync(path.join(jobDir(id), 'input.mime'), photo.mime);
  queue.push(id);
  pump();
  return q.get('SELECT * FROM ai_jobs WHERE id = ?', id);
}

/* presenter video: an AI model photo (the first frame) + what the presenter says → 8 s or ~15 s video with voice */
const presenterCredits = sec => sec === 15 ? config.ai.presenterCredits15 : config.ai.presenterCredits;
function createPresenterJob(user, { from, parts, language, tone, look, seconds, aspect, label, product }) {
  if (!enabled()) throw new HttpErr(503, 'AI studio is paused for maintenance. Please try again later.');
  if (user.role === 'viewer') throw new HttpErr(403, 'Viewers can look at designs but not create AI videos.');
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', user.workspace_id);
  if (!effectivePlan(ws).ai_video) throw new HttpErr(402, 'Presenter videos are included in the Pro, Business and Agency plans.', { code: 'ai_video_plan' });
  seconds = +seconds === 15 ? 15 : 8;
  const out = from && from.id ? outputFile(user, from.id, from.n || 0) : null;
  if (!out || out.job.kind !== 'image' || !out.job.template_key.startsWith('model:') || !fs.existsSync(out.path))
    throw new HttpErr(400, 'Pick one of your AI model photos to start the video from (make one in “Photo with product” first).');
  const ch = characters.byKey(out.job.template_key.split(':')[1]);
  if (!ch) throw new HttpErr(400, 'That AI model is no longer available.');
  const lang = String(language || 'English').slice(0, 30).replace(/[^\p{L} ()-]/gu, '') || 'English';
  const chk = script.check(parts, seconds, lang);
  if (chk.problem) throw new HttpErr(400, chk.problem, { code: 'script' });
  aspect = ['9:16', '4:5', '1:1', '16:9'].includes(aspect) ? aspect : '9:16';
  const lookKey = look in characters.LOOKS ? look : (() => { try { return JSON.parse(out.job.inputs).look || 'studio'; } catch { return 'studio'; } })();
  fairUse(user);
  const provider = videogen.active();
  const estimate = provider === 'veo' ? config.ai.videoCostPerSec * (seconds === 15 ? 16 : 8) : 0;
  if (spentToday() + estimate > dailyBudget()) throw new HttpErr(503, 'AI studio has reached today’s limit. Please try again tomorrow.', { code: 'ai_budget' });
  const credits = presenterCredits(seconds);
  let prodName = String(product || '').slice(0, 120);
  if (!prodName) { try { prodName = JSON.parse(out.job.inputs).product || ''; } catch {} }
  const input = { product: prodName, character: ch.key, parts: chk.parts, language: lang, tone: script.TONES[tone] ? tone : 'friendly', look: lookKey, seconds, label: label !== false, presenter: true };
  const id = crypto.randomBytes(12).toString('hex');
  tx(() => {
    const fromTopup = charge(user, credits);
    q.run(`INSERT INTO ai_jobs (id, user_id, workspace_id, template_key, kind, status, provider, model, inputs, prompt, aspect, count, credits, credits_topup, local_month, cost_usd, created_at)
           VALUES (?,?,?,?,'video','queued',?,?,?,?,?,1,?,?,?,?,?)`,
      id, user.id, user.workspace_id, `presenter:${ch.key}`, provider, provider === 'veo' ? config.ai.veoModel : 'demo', JSON.stringify(input),
      chk.parts.join(' / '), aspect, credits, fromTopup, localParts(user.timezone).month, estimate, Date.now());
  });
  fs.mkdirSync(jobDir(id), { recursive: true });
  fs.writeFileSync(path.join(jobDir(id), 'input'), fs.readFileSync(out.path), { mode: 0o600 });
  fs.writeFileSync(path.join(jobDir(id), 'input.mime'), out.file.endsWith('.jpg') ? 'image/jpeg' : out.file.endsWith('.webp') ? 'image/webp' : 'image/png');
  vqueue.push(id);
  vpump();
  return q.get('SELECT * FROM ai_jobs WHERE id = ?', id);
}

async function runPresenter(job) {
  const id = job.id, dir = jobDir(id);
  const inp = JSON.parse(job.inputs);
  const ch = characters.byKey(inp.character);
  const sec1 = 8;
  let cost = 0;
  try {
    if (!ch) throw new providers.AiError('That AI model is no longer available. Your credits were returned.', 'failed');
    if (!fs.existsSync(path.join(dir, 'input'))) throw new providers.AiError('The start picture was lost (server restart). Your credits were returned — please try again.', 'failed');
    const start = { buffer: fs.readFileSync(path.join(dir, 'input')), mime: fs.readFileSync(path.join(dir, 'input.mime'), 'utf8') };
    const prep = await videogen.prepareStart(start.buffer, job.aspect, dir);
    const opts = { language: inp.language, tone: script.TONES[inp.tone], seconds: sec1 };
    let raw;
    if (job.provider === 'veo') {
      let op = job.remote_op;
      if (!op) {
        op = await videogen.veoStart({ prompt: buildPresenterPrompt(ch, inp.look, inp.parts[0], opts), negative: PRESENTER_NEGATIVE, png: prep.png, gen: prep.gen, seconds: sec1, audio: true });
        q.run('UPDATE ai_jobs SET remote_op = ? WHERE id = ?', op, id);
      }
      cost += config.ai.videoCostPerSec * sec1;
      raw = await videogen.veoWait(op, { deadline: Date.now() + config.ai.videoTimeoutMin * 60000 });
      if (inp.seconds === 15 && inp.parts[1]) {
        const p2 = buildPresenterPrompt(ch, inp.look, inp.parts[1], { ...opts, seconds: 7, continuing: true });
        const ext = await videogen.veoExtend({ prompt: p2, mp4: raw });
        if (ext) {
          cost += config.ai.videoCostPerSec * 7;
          raw = await videogen.veoWait(ext, { deadline: Date.now() + config.ai.videoTimeoutMin * 60000 });
        } else {
          // this model can't extend: film part 2 from the last frame of part 1 and join them
          const png2 = await videogen.lastFrame(raw, dir);
          const op2 = await videogen.veoStart({ prompt: buildPresenterPrompt(ch, inp.look, inp.parts[1], { ...opts, continuing: true }), negative: PRESENTER_NEGATIVE, png: png2, gen: prep.gen, seconds: sec1, audio: true });
          cost += config.ai.videoCostPerSec * sec1;
          const raw2 = await videogen.veoWait(op2, { deadline: Date.now() + config.ai.videoTimeoutMin * 60000 });
          raw = await videogen.joinParts(raw, raw2, dir);
        }
      }
    } else {
      raw = await videogen.demoPresenter({ png: prep.png, gen: prep.gen, seconds: inp.seconds, dir });
    }
    const fin = await videogen.finish(raw, job.aspect, dir, 0, { audio: true, label: inp.label !== false });
    // quality check on 3 frames: no added lettering/subtitles, the same product, one natural-looking person
    const checker = config.ai.geminiKey ? 'gemini' : config.ai.openaiKey ? 'openai' : null;
    if (qualityCheck() && job.provider !== 'demo' && checker) {
      const frames = await videogen.sampleFrames(path.join(dir, fin.file), inp.seconds, dir);
      for (const fr of frames) {
        cost += providers.CHECK_COST[checker] || 0;
        const v = await providers.checkImage({ image: fr, photo: start, provider: checker, person: true });
        if (v && !v.ok) {
          q.run('UPDATE ai_jobs SET rejected = 1 WHERE id = ?', id);
          fs.rmSync(path.join(dir, fin.file), { force: true }); fs.rmSync(path.join(dir, fin.poster), { force: true });
          throw new providers.AiError('We couldn’t get a clean video this time (the AI added writing or changed the product or person), so your credits were returned. Try again or start from another model photo.', 'quality', v.problems.join(', '));
        }
      }
    }
    q.run("UPDATE ai_jobs SET status = 'done', outputs = ?, cost_usd = ?, remote_op = '', finished_at = ? WHERE id = ?", JSON.stringify([fin.file]), cost, Date.now(), id);
  } catch (e) {
    console.error('[ai-presenter]', id, e.reason || '', e.message, e.detail || '');
    const j = q.get('SELECT * FROM ai_jobs WHERE id = ?', id);
    const spent = e.reason === 'auth' || e.reason === 'busy' || (e.reason === 'blocked' && !cost) ? 0 : cost;
    fail(j, e.reason ? e : new providers.AiError('The AI could not make this video. Please try again.', 'failed', e.message), spent);
  } finally {
    for (const f of ['input', 'start.png']) fs.rm(path.join(dir, f), { force: true }, () => {});
  }
}

function pump() {
  while (running < config.ai.jobs && queue.length) {
    const id = queue.shift();
    running++;
    run(id).finally(() => { running--; pump(); });
  }
}


/* ---------- AI videos (phase B) ---------- */
const vqueue = [];
let vrunning = 0;

function createVideoJob(user, { templateKey, input, photo, from, aspect, seconds }) {
  if (!enabled()) throw new HttpErr(503, 'AI studio is paused for maintenance. Please try again later.');
  if (user.role === 'viewer') throw new HttpErr(403, 'Viewers can look at designs but not create AI videos.');
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', user.workspace_id);
  const plan = effectivePlan(ws);
  if (!plan.ai_video) throw new HttpErr(402, 'AI videos are included in the Pro and Business plans. Upgrade to make product videos.', { code: 'ai_video_plan' });
  const tpl = q.get("SELECT * FROM ai_templates WHERE key = ? AND active = 1 AND kind = 'video'", String(templateKey || ''));
  if (!tpl) throw new HttpErr(400, 'Pick a motion first.');
  // start picture: one of your AI images, or a photo you upload
  if (!photo && from && from.id) {
    const out = outputFile(user, from.id, from.n || 0);
    if (!out || out.job.kind !== 'image' || !fs.existsSync(out.path)) throw new HttpErr(404, 'That AI image is no longer available. Pick another one.');
    photo = { buffer: fs.readFileSync(out.path), mime: out.file.endsWith('.jpg') ? 'image/jpeg' : out.file.endsWith('.webp') ? 'image/webp' : 'image/png' };
    if (!String(input.product || '').trim()) { try { input = { ...input, product: JSON.parse(out.job.inputs).product || '', price: JSON.parse(out.job.inputs).price || '' }; } catch {} }
  }
  if (!photo) throw new HttpErr(400, 'Pick one of your AI images or add a photo to start the video from.');
  aspect = ASPECTS.includes(aspect) ? aspect : '9:16';
  seconds = videogen.SECONDS.includes(+seconds) ? +seconds : 6;
  fairUse(user);
  const provider = videogen.active();
  const estimate = provider === 'veo' ? config.ai.videoCostPerSec * seconds : 0;
  if (spentToday() + estimate > dailyBudget()) throw new HttpErr(503, 'AI studio has reached today’s limit. Please try again tomorrow.', { code: 'ai_budget' });
  const credits = config.ai.videoCredits;
  const prompt = buildVideoPrompt(tpl, input, { seconds });
  const id = crypto.randomBytes(12).toString('hex');
  tx(() => {
    const fromTopup = charge(user, credits);
    q.run(`INSERT INTO ai_jobs (id, user_id, workspace_id, template_key, kind, status, provider, model, inputs, prompt, aspect, count, credits, credits_topup, local_month, cost_usd, created_at)
           VALUES (?,?,?,?,'video','queued',?,?,?,?,?,1,?,?,?,?,?)`,
      id, user.id, user.workspace_id, tpl.key, provider, provider === 'veo' ? config.ai.veoModel : 'demo', JSON.stringify({ ...input, seconds }), prompt, aspect,
      credits, fromTopup, localParts(user.timezone).month, estimate, Date.now());
  });
  fs.mkdirSync(jobDir(id), { recursive: true });
  fs.writeFileSync(path.join(jobDir(id), 'input'), photo.buffer, { mode: 0o600 });
  fs.writeFileSync(path.join(jobDir(id), 'input.mime'), photo.mime);
  vqueue.push(id);
  vpump();
  return q.get('SELECT * FROM ai_jobs WHERE id = ?', id);
}

async function runVideo(id) {
  let job = q.get('SELECT * FROM ai_jobs WHERE id = ?', id);
  if (!job || job.status !== 'queued') return;
  q.run("UPDATE ai_jobs SET status = 'running' WHERE id = ?", id);
  if (job.template_key.startsWith('presenter:')) return runPresenter(job);
  const dir = jobDir(id);
  const seconds = (() => { try { return JSON.parse(job.inputs).seconds || 6; } catch { return 6; } })();
  let cost = 0, redone = 0;
  try {
    if (!fs.existsSync(path.join(dir, 'input'))) throw new providers.AiError('The start picture was lost (server restart). Your credits were returned — please try again.', 'failed');
    const start = { buffer: fs.readFileSync(path.join(dir, 'input')), mime: fs.readFileSync(path.join(dir, 'input.mime'), 'utf8') };
    const prep = await videogen.prepareStart(start.buffer, job.aspect, dir);
    const checking = qualityCheck() && job.provider !== 'demo';
    const checker = config.ai.geminiKey ? 'gemini' : config.ai.openaiKey ? 'openai' : null;
    let fin = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let raw;
      if (job.provider === 'veo') {
        let op = attempt === 1 ? job.remote_op : '';
        if (!op) {
          op = await videogen.veoStart({ prompt: job.prompt, negative: VIDEO_NEGATIVE, png: prep.png, gen: prep.gen, seconds });
          q.run('UPDATE ai_jobs SET remote_op = ? WHERE id = ?', op, id);
        }
        cost += config.ai.videoCostPerSec * seconds;
        raw = await videogen.veoWait(op, { deadline: Date.now() + config.ai.videoTimeoutMin * 60000 });
      } else {
        raw = await videogen.demoClip({ png: prep.png, gen: prep.gen, seconds, dir });
      }
      fin = await videogen.finish(raw, job.aspect, dir, 0);
      if (!checking || !checker) break;
      // quality check on 3 frames against the start picture: no lettering, same unchanged product
      const frames = await videogen.sampleFrames(path.join(dir, fin.file), seconds, dir);
      let bad = null;
      for (const fr of frames) {
        cost += providers.CHECK_COST[checker] || 0;
        const v = await providers.checkImage({ image: fr, photo: start, provider: checker });
        if (v && !v.ok) { bad = v; break; }
      }
      if (!bad) break;
      console.warn('[ai-check] video', id, 'attempt', attempt, 'rejected:', bad.problems.join(', '), bad.notes || '');
      if (attempt === 2) {
        q.run('UPDATE ai_jobs SET redone = ?, rejected = 1 WHERE id = ?', redone, id);
        throw new providers.AiError('We couldn’t get a clean video this time (the AI kept adding writing or changing your product), so your credits were returned. Try another motion or start picture.', 'quality', bad.problems.join(', '));
      }
      redone++;
      fs.rmSync(path.join(dir, fin.file), { force: true }); fs.rmSync(path.join(dir, fin.poster), { force: true });
    }
    q.run("UPDATE ai_jobs SET status = 'done', outputs = ?, cost_usd = ?, redone = ?, remote_op = '', finished_at = ? WHERE id = ?",
      JSON.stringify([fin.file]), cost, redone, Date.now(), id);
  } catch (e) {
    console.error('[ai-video]', id, e.reason || '', e.message, e.detail || '');
    job = q.get('SELECT * FROM ai_jobs WHERE id = ?', id);
    // a video the service finished counts as spent even if a later step failed
    const spent = e.reason === 'auth' || e.reason === 'busy' || (e.reason === 'blocked' && !cost) ? 0 : cost;
    fail(job, e.reason ? e : new providers.AiError('The AI could not make this video. Please try again.', 'failed', e.message), spent);
  } finally {
    for (const f of ['input', 'start.png']) fs.rm(path.join(dir, f), { force: true }, () => {});
  }
}

function vpump() {
  while (vrunning < config.ai.videoJobs && vqueue.length) {
    const id = vqueue.shift();
    vrunning++;
    runVideo(id).finally(() => { vrunning--; vpump(); });
  }
}

/* after a restart: videos carry on (we keep waiting for the AI service — no second charge);
   unfinished images are cancelled and refunded (they only take seconds to redo) */
for (const j of q.all("SELECT * FROM ai_jobs WHERE status IN ('queued','running')")) {
  if (j.kind === 'video' && fs.existsSync(path.join(jobDir(j.id), 'input'))) {
    q.run("UPDATE ai_jobs SET status = 'queued' WHERE id = ?", j.id);
    vqueue.push(j.id);
  } else fail(j, new Error('The server restarted while making this — your credits were returned. Please try again.'));
}
setImmediate(vpump);

/* keep generated files 30 days */
setInterval(() => {
  const old = q.all('SELECT id FROM ai_jobs WHERE created_at < ? AND outputs != ?', Date.now() - 30 * DAY, '[]');
  for (const j of old) { fs.rm(jobDir(j.id), { recursive: true, force: true }, () => {}); q.run("UPDATE ai_jobs SET outputs = '[]' WHERE id = ?", j.id); }
}, 6 * 3600 * 1000).unref();

function outputFile(user, id, n, { poster = false } = {}) {
  const j = q.get('SELECT * FROM ai_jobs WHERE id = ? AND workspace_id = ?', String(id), user.workspace_id);
  if (!j) return null;
  let f = JSON.parse(j.outputs || '[]')[parseInt(n, 10)];
  if (f && poster) f = j.kind === 'video' ? f.replace(/^video-(\d+)\.mp4$/, 'poster-$1.jpg') : f;
  return f ? { path: path.join(jobDir(j.id), f), job: j, file: f } : null;
}

/* Put a result into the media library and open it as a new design */
function toDesign(user, id, n) {
  const out = outputFile(user, id, n);
  if (!out || !fs.existsSync(out.path)) throw new HttpErr(404, 'This AI result is no longer available.');
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', user.workspace_id);
  const plan = effectivePlan(ws);
  const buf = fs.readFileSync(out.path);
  if (storageUsed(ws.id) + buf.length > plan.storage_mb * 1024 * 1024) throw new HttpErr(413, 'Your storage is full. Delete old media or upgrade your plan.');
  if (plan.max_designs >= 0) {
    const nDesigns = q.get('SELECT COUNT(*) n FROM designs WHERE workspace_id = ? AND deleted_at IS NULL', ws.id).n;
    if (nDesigns >= plan.max_designs) throw new HttpErr(402, `Your ${plan.name} plan can keep ${plan.max_designs} saved designs. Delete one or upgrade.`);
  }
  const isVideo = out.file.endsWith('.mp4');
  const mime = isVideo ? 'video/mp4' : out.file.endsWith('.jpg') ? 'image/jpeg' : out.file.endsWith('.webp') ? 'image/webp' : 'image/png';
  const mediaId = crypto.randomUUID();
  const dir = path.join(config.UPLOAD_DIR, String(ws.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, mediaId), buf, { mode: 0o600 });
  let input = {}; try { input = JSON.parse(out.job.inputs); } catch {}
  const who = input.character && characters.byKey(input.character);
  const name = `AI${who ? ' ' + who.name : ''} · ${(input.product || 'Product').slice(0, 60)}`;
  const now = Date.now();
  q.run('INSERT INTO media (id, workspace_id, owner_id, filename, mime, kind, size, created_at) VALUES (?,?,?,?,?,?,?,?)',
    mediaId, ws.id, user.id, `ai-${out.job.id.slice(0, 8)}-${n}.${out.file.split('.').pop()}`, mime, isVideo ? 'video' : 'image', buf.length, now);
  const data = {
    v: 1, contentType: 'promo', platformKey: PLATFORM_FOR[out.job.aspect] || 'ig_portrait',
    mediaId, mediaName: name, mediaKind: isVideo ? 'video' : 'image', mediaFit: 'auto', fitBg: 'blur',
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
  const agg = since => q.get(`SELECT COUNT(*) jobs, COALESCE(SUM(CASE WHEN status='done' AND kind='image' THEN credits END),0) images,
    COALESCE(SUM(status='done' AND kind='video'),0) videos,
    COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(status='failed'),0) failed,
    COALESCE(SUM(redone),0) redone, COALESCE(SUM(rejected),0) rejected FROM ai_jobs WHERE created_at >= ?`, since);
  return {
    enabled: enabled(), qualityCheck: qualityCheck(), dailyBudget: dailyBudget(), provider: providers.active(),
    keys: { gemini: !!config.ai.geminiKey, openai: !!config.ai.openaiKey },
    models: { gemini: config.ai.geminiImageModel, openai: config.ai.openaiImageModel },
    today: agg(start.getTime()), month: agg(month.getTime()),
    recentErrors: q.all("SELECT id, template_key, provider, error, created_at FROM ai_jobs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10"),
    // the AI account itself has a problem (no quota / billing / disabled API) — shown as a banner to admins
    accountAlert: q.get("SELECT error, provider, created_at FROM ai_jobs WHERE status = 'failed' AND created_at > ? AND error LIKE '%needs attention%' ORDER BY created_at DESC LIMIT 1", Date.now() - DAY) || null,
    queue: { running: running + vrunning, waiting: queue.length + vqueue.length },
    videoProvider: videogen.active(), videoModel: config.ai.veoModel, videoCredits: config.ai.videoCredits,
  };
}

module.exports = {
  INDUSTRIES, ASPECTS, templates, creditStatus, addTopup, createJob, createVideoJob, createModelJob, createPresenterJob, presenterCredits, characterPortraitUrl, CHAR_DIR,
  publicJob, outputFile, toDesign, stats,
  enabled, qualityCheck, setQualityCheck: v => metaSet('ai_quality_check', v ? '1' : '0'), setEnabled: v => metaSet('ai_enabled', v ? '1' : '0'), setDailyBudget: v => metaSet('ai_daily_budget', String(v)),
  HttpErr, _queueIdle: () => running === 0 && queue.length === 0 && vrunning === 0 && vqueue.length === 0,
};
