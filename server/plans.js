'use strict';
/* Plan entitlements and export-quota accounting. */
const { q } = require('./db');

function getPlan(code) {
  return q.get('SELECT * FROM plans WHERE code = ?', code) || q.get("SELECT * FROM plans WHERE code = 'free'");
}

function subscriptionIsLive(ws) {
  if (!ws || ws.plan_code === 'free') return false;
  if (!['active', 'trialing', 'past_due'].includes(ws.sub_status)) return false;
  // allow a 3-day grace period after the period end for renewals to land
  if (ws.current_period_end && ws.current_period_end + 3 * 86400000 < Date.now()) return false;
  return true;
}

/* The plan a workspace is *actually* entitled to right now. */
function effectivePlan(ws) {
  // Demo billing auto-renews unless cancelled (real Stripe renewals arrive by webhook)
  if (ws && ws.billing_mode === 'demo' && !ws.cancel_at_period_end && ws.current_period_end && ws.current_period_end < Date.now()) {
    ws.current_period_end = Date.now() + 30 * 86400000;
    q.run('UPDATE workspaces SET current_period_end = ? WHERE id = ?', ws.current_period_end, ws.id);
  }
  return subscriptionIsLive(ws) ? getPlan(ws.plan_code) : getPlan('free');
}

function localParts(tz, date = new Date()) {
  let s;
  try {
    s = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    s = date.toISOString().slice(0, 10);
  }
  return { day: s, month: s.slice(0, 7) };
}

/* Download allowance for one user on a plan.
   Paid plans can have a monthly allowance AND a daily cap (e.g. 5/day, max 100/month);
   the free trial is a one-off allowance. Paid allowances only count paid downloads. */
function usageFor(user, plan) {
  const { day, month } = localParts(user.timezone);
  if (plan.quota_period === 'lifetime') {
    const used = q.get("SELECT COUNT(*) n FROM exports WHERE user_id = ? AND plan_code = 'free'", user.id).n;
    const limit = plan.quota_limit;
    return { used, limit, remaining: Math.max(0, limit - used), period: 'lifetime', binding: 'trial',
      day: null, month: null, label: 'in your free trial', resets: 'Free-trial allowance — upgrade for more' };
  }
  const dayUsed = q.get("SELECT COUNT(*) n FROM exports WHERE user_id = ? AND local_day = ? AND plan_code != 'free'", user.id, day).n;
  const monthUsed = q.get("SELECT COUNT(*) n FROM exports WHERE user_id = ? AND local_month = ? AND plan_code != 'free'", user.id, month).n;
  const dayLimit = plan.quota_period === 'day' ? plan.quota_limit : (plan.daily_limit || 0);
  const monthLimit = plan.quota_period === 'month' ? plan.quota_limit : 0;
  const dayRem = dayLimit ? Math.max(0, dayLimit - dayUsed) : Infinity;
  const monthRem = monthLimit ? Math.max(0, monthLimit - monthUsed) : Infinity;
  const bindingDay = dayRem <= monthRem;
  const remaining = Math.min(dayRem, monthRem);
  return {
    used: bindingDay ? dayUsed : monthUsed, limit: bindingDay ? dayLimit : monthLimit,
    remaining: Number.isFinite(remaining) ? remaining : 999999,
    period: bindingDay ? 'day' : 'month', binding: bindingDay ? 'day' : 'month',
    day: dayLimit ? { used: dayUsed, limit: dayLimit } : null,
    month: monthLimit ? { used: monthUsed, limit: monthLimit } : null,
    label: bindingDay ? 'today' : 'this month',
    resets: bindingDay ? 'Daily allowance resets at midnight (your time zone)' : 'Monthly allowance resets on the 1st',
  };
}

/* Plan fields safe to send to the browser */
function publicPlan(p) {
  return {
    code: p.code, name: p.name, description: p.description, price_cents: p.price_cents, currency: p.currency,
    price_cents_annual: p.price_cents_annual || 0, annual_available: !!(p.price_cents_annual && p.price_cents > 0),
    quota_limit: p.quota_limit, quota_period: p.quota_period, daily_limit: p.daily_limit || 0, max_quality: p.max_quality,
    video_export: !!p.video_export, batch_export: !!p.batch_export, premium_templates: !!p.premium_templates,
    watermark: !!p.watermark, max_designs: p.max_designs, max_brand_kits: p.max_brand_kits,
    max_upload_mb: p.max_upload_mb, storage_mb: p.storage_mb,
    audience: p.audience || 'both',
    max_video_mb: p.max_video_mb || p.max_upload_mb, max_video_seconds: p.max_video_seconds || 0, ai_video: !!p.ai_video,
    ai_credits_monthly: p.ai_credits_monthly || 0, ai_credits_lifetime: p.ai_credits_lifetime || 0,
  };
}

function storageUsed(workspaceId) {
  return q.get('SELECT COALESCE(SUM(size),0) s FROM media WHERE workspace_id = ?', workspaceId).s;
}

module.exports = { getPlan, effectivePlan, subscriptionIsLive, usageFor, publicPlan, localParts, storageUsed };
