'use strict';
/* Subscriptions, priced per user (seat).
   - With STRIPE_SECRET_KEY set: real Stripe Checkout, Customer Portal and webhooks.
   - Without it: "demo billing" — plan changes apply instantly with no payment,
     clearly labelled in the UI, so you can test the whole flow locally. */
const express = require('express');
const config = require('../config');
const { q } = require('../db');
const S = require('../security');
const { publicPlan, getPlan } = require('../plans');

const router = express.Router();
const stripe = config.stripe.secretKey ? require('stripe')(config.stripe.secretKey) : null;
const DAY = 86400000;

router.get('/billing/plans', (req, res) => {
  const plans = q.all('SELECT * FROM plans WHERE active = 1 AND public = 1 ORDER BY sort, price_cents').map(publicPlan);
  res.json({ plans, mode: stripe ? 'stripe' : 'demo' });
});

function memberCount(wsId) {
  return q.get("SELECT COUNT(*) n FROM users WHERE workspace_id = ? AND status != 'removed' AND client_brand_id IS NULL", wsId).n;
}

router.post('/billing/checkout', S.requireRole('owner'), async (req, res) => {
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', req.user.workspace_id);
  const plan = q.get('SELECT * FROM plans WHERE code = ? AND active = 1 AND public = 1', String(req.body.plan || ''));
  if (!plan || plan.price_cents <= 0) throw new S.HttpError(400, 'Choose a paid plan.');
  const seats = parseInt(req.body.seats, 10) || 1;
  if (seats < 1 || seats > 200) throw new S.HttpError(400, 'Seats must be between 1 and 200.');
  if (seats < memberCount(ws.id)) throw new S.HttpError(400, `You have ${memberCount(ws.id)} team members — remove some before reducing seats.`);
  const interval = req.body.interval === 'year' ? 'year' : 'month';
  if (interval === 'year' && !(plan.price_cents_annual > 0)) throw new S.HttpError(400, `${plan.name} has no yearly option.`);

  if (!stripe) {
    q.run(`UPDATE workspaces SET plan_code = ?, seats = ?, sub_status = 'active', billing_mode = 'demo', billing_interval = ?,
           cancel_at_period_end = 0, current_period_end = ? WHERE id = ?`, plan.code, seats, interval,
      Date.now() + (interval === 'year' ? 365 : 30) * DAY, ws.id);
    S.audit(req, 'billing.demo_subscribe', { plan: plan.code, seats, interval });
    return res.json({ ok: true, mode: 'demo' });
  }

  const priceId = interval === 'year' ? plan.stripe_price_id_annual : plan.stripe_price_id;
  if (!priceId) throw new S.HttpError(500, `Stripe ${interval === 'year' ? 'yearly' : 'monthly'} price ID for ${plan.name} is not configured.`);

  // Existing subscription → change plan/seats in place (prorated)
  if (ws.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(ws.sub_status)) {
    const sub = await stripe.subscriptions.retrieve(ws.stripe_subscription_id);
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: sub.items.data[0].id, price: priceId, quantity: seats }],
      proration_behavior: 'create_prorations',
      cancel_at_period_end: false,
      metadata: { workspace_id: String(ws.id), plan: plan.code },
    });
    S.audit(req, 'billing.subscription_changed', { plan: plan.code, seats, interval });
    return res.json({ ok: true, mode: 'stripe', updated: true });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: seats }],
    client_reference_id: String(ws.id),
    ...(ws.stripe_customer_id ? { customer: ws.stripe_customer_id } : { customer_email: req.user.email }),
    metadata: { workspace_id: String(ws.id), plan: plan.code },
    subscription_data: { metadata: { workspace_id: String(ws.id), plan: plan.code } },
    allow_promotion_codes: true,
    success_url: `${config.appUrl}/app?checkout=success#billing`,
    cancel_url: `${config.appUrl}/app?checkout=cancelled#billing`,
  });
  S.audit(req, 'billing.checkout_started', { plan: plan.code, seats, interval });
  res.json({ ok: true, mode: 'stripe', url: session.url });
});

/* AI credit packs (one-off payment, never expire) */
router.post('/billing/ai-topup', S.requireRole('admin'), async (req, res) => {
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', req.user.workspace_id);
  const credits = config.ai.topupCredits, cents = config.ai.topupPriceCents;
  if (!stripe) {
    require('../ai').addTopup(ws.id, credits);
    S.audit(req, 'billing.demo_ai_topup', { credits });
    return res.json({ ok: true, mode: 'demo', credits });
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents, product_data: { name: `${credits} AI credits (PostForge)` } } }],
    client_reference_id: String(ws.id),
    ...(ws.stripe_customer_id ? { customer: ws.stripe_customer_id } : { customer_email: req.user.email }),
    metadata: { workspace_id: String(ws.id), ai_credits: String(credits) },
    success_url: `${config.appUrl}/ai?topup=success`,
    cancel_url: `${config.appUrl}/ai?topup=cancelled`,
  });
  S.audit(req, 'billing.ai_topup_started', { credits });
  res.json({ ok: true, mode: 'stripe', url: session.url });
});

router.post('/billing/portal', S.requireRole('owner'), async (req, res) => {
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', req.user.workspace_id);
  if (!stripe || !ws.stripe_customer_id) throw new S.HttpError(400, 'No Stripe billing account yet.');
  const s = await stripe.billingPortal.sessions.create({ customer: ws.stripe_customer_id, return_url: `${config.appUrl}/app#billing` });
  res.json({ url: s.url });
});

router.post('/billing/cancel', S.requireRole('owner'), async (req, res) => {
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', req.user.workspace_id);
  const resume = !!req.body.resume;
  if (ws.billing_mode === 'stripe' && stripe && ws.stripe_subscription_id) {
    await stripe.subscriptions.update(ws.stripe_subscription_id, { cancel_at_period_end: !resume });
  }
  q.run('UPDATE workspaces SET cancel_at_period_end = ? WHERE id = ?', resume ? 0 : 1, ws.id);
  S.audit(req, resume ? 'billing.resumed' : 'billing.cancel_requested');
  res.json({ ok: true });
});

/* ---------------- Stripe webhook (raw body, signature-verified) ---------------- */
function applySubscription(sub) {
  const wsId = parseInt(sub.metadata?.workspace_id, 10) ||
    q.get('SELECT id FROM workspaces WHERE stripe_subscription_id = ?', sub.id)?.id;
  if (!wsId) return;
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id;
  const plan = q.get("SELECT code, CASE WHEN stripe_price_id_annual = ? THEN 'year' ELSE 'month' END AS interval FROM plans WHERE (stripe_price_id = ? OR stripe_price_id_annual = ?) AND ? != ''", priceId, priceId, priceId, priceId || '');
  const periodEnd = (item?.current_period_end || sub.current_period_end || 0) * 1000 || null;
  const status = sub.status === 'unpaid' || sub.status === 'incomplete_expired' ? 'canceled' : sub.status;
  if (plan) q.run('UPDATE workspaces SET billing_interval = ? WHERE id = ?', plan.interval, wsId);
  q.run(`UPDATE workspaces SET plan_code = COALESCE(?, plan_code), seats = ?, sub_status = ?, current_period_end = ?,
         cancel_at_period_end = ?, billing_mode = 'stripe', stripe_subscription_id = ?, stripe_customer_id = COALESCE(?, stripe_customer_id)
         WHERE id = ?`,
    plan?.code || null, Math.max(1, item?.quantity || 1), status, periodEnd, sub.cancel_at_period_end ? 1 : 0,
    sub.id, typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null, wsId);
}

async function webhook(req, res) {
  if (!stripe || !config.stripe.webhookSecret) return res.status(400).send('Stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.stripe.webhookSecret);
  } catch (e) {
    return res.status(400).send('Bad signature');
  }
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const wsId = parseInt(s.client_reference_id, 10);
        if (wsId && s.mode === 'payment' && s.metadata?.ai_credits && s.payment_status === 'paid') {
          // one-off AI credit pack; the session id guards against counting the same payment twice
          if (!q.get("SELECT id FROM audit_log WHERE action = 'billing.ai_topup_paid' AND detail LIKE ?", `%${s.id}%`)) {
            require('../ai').addTopup(wsId, parseInt(s.metadata.ai_credits, 10) || 0);
            q.run('INSERT INTO audit_log (action, detail, created_at) VALUES (?,?,?)', 'billing.ai_topup_paid', JSON.stringify({ session: s.id, workspace: wsId }), Date.now());
          }
          break;
        }
        if (wsId && s.subscription) {
          q.run('UPDATE workspaces SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?', s.customer, s.subscription, wsId);
          applySubscription(await stripe.subscriptions.retrieve(s.subscription));
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        applySubscription(event.data.object);
        break;
      case 'invoice.payment_failed': {
        const subId = event.data.object.subscription || event.data.object.parent?.subscription_details?.subscription;
        if (subId) q.run("UPDATE workspaces SET sub_status = 'past_due' WHERE stripe_subscription_id = ?", subId);
        break;
      }
    }
    q.run('INSERT INTO audit_log (action, detail, created_at) VALUES (?,?,?)', 'billing.webhook', JSON.stringify({ type: event.type, id: event.id }), Date.now());
    res.json({ received: true });
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).send('error');
  }
}

module.exports = { router, webhook, getPlan };
