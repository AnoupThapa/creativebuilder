# PostForge — Social Media Design Creator (SaaS)

A multi-user web app that lets small businesses turn one photo or video into ready-to-post designs
for 14 platform sizes — now with accounts, teams, plans, billing and security controls.

Built from the original single-file `index.html` editor (canvas engine, templates, background removal,
brand-colour extraction, batch/video export), which now runs inside a full Node.js application.

---

## 1. Run it on Windows — no Command Prompt

1. Install **Node.js LTS** from https://nodejs.org (default options) — one time only.
2. In the `postforge-app` folder, double-click **PostForge.vbs**.
   * The first time, this adds a **PostForge** shortcut (coral "P" icon) to your **Desktop** and **Start menu** — use that from then on.
3. The **PostForge Control Panel** opens:
   * **Platform admin login** — type your admin email + password (twice) and click **Save admin login**. No need to edit `.env` in Notepad; changing it later also updates the admin account's password.
   * **Start & open** — installs packages automatically on the first run, starts the app in the background (no black window) and opens it in your browser.
   * **Stop app**, **Open in browser**, **Admin** (opens /admin), port setting, "Desktop shortcut" (re-creates it), "Open app folder", and an activity log.
   * Tick *Start the app automatically when this window opens* so the shortcut is a one-click start.
   * Closing the panel keeps the app running; use **Stop app** to turn it off.

If Windows asks about running the script, choose *Open/Run* (it only starts PostForge on your own computer).
Logs are in `data\server.log` and `data\server-error.log`.

## 1b. Run it from a terminal (macOS / Linux / advanced)

Requires **Node.js 22.13+** (Node 24 LTS recommended) — no database server or native build tools needed
(SQLite is built into Node).

```bash
cd postforge-app
npm install
copy .env.example .env      # (macOS/Linux: cp .env.example .env) then set ADMIN_EMAIL / ADMIN_PASSWORD
npm start
```

Open http://localhost:3000 → **Start free** to create an account.
If you don't set `ADMIN_EMAIL/ADMIN_PASSWORD`, a platform-admin login is printed in the console on first start.

In development:
* **Emails** (verification, password reset, team invites) are printed to the console and shown in
  *Admin → Email outbox*; the app also shows a "Dev mode" link so you can click straight through.
* **Billing** runs in *demo mode* — choosing a plan activates it instantly with no payment.

Run the automated test suite (auth, quotas, roles, isolation, 2FA, admin): `npm test`

---

## 2. Plans (per user, US dollars)

| Plan | Monthly | Yearly (2 months free) | Allowance (per user) | Extras |
|---|---|---|---|---|
| Free trial | $0 | — | 3 downloads total, watermarked | 1× quality, 5 saved designs, 1 brand kit, 1 user |
| **Starter** | **$10 / user / month** | **$100 / user / year** | **5 images a day, up to 100 a month** | Multi-platform ZIP, 2× HD, all templates, no watermark, team seats |
| **Pro** | **$20 / user / month** | **$200 / user / year** | **15 images a day, up to 300 a month** | Everything in Starter + MP4 video posts with sound, 3× print quality, 5 brand kits, unlimited designs |

* Pro is now the clear upgrade: 3× the images of Starter, plus video.
* Daily allowances reset at the user's local midnight; monthly ones on the 1st.
* Every file downloaded counts once (a ZIP of 4 sizes = 4 images). Editing and previewing are unlimited.
* The workspace owner buys **seats**; each team member uses one seat and gets their own allowance.
* Customers choose **Monthly** or **Yearly** on the pricing page and in *Plan & billing*.
* Everything is editable in *Platform admin → Plans & pricing* (monthly/yearly price, monthly quota, daily cap, features).

---|---|---|---|
| Free trial | $0 | 3 downloads total, watermarked | 1× quality, 5 saved designs, 1 brand kit, 1 user |
| **Starter** | **$10 / user / month** | **5 images per day** (resets at the user's local midnight) | Multi-platform ZIP, 2× HD, all templates, 1 brand kit, no watermark, team seats |
| **Pro** | **$20 / user / month** | **50 images per month** (resets on the 1st) | Everything in Starter + video posts with sound, 3× print quality, 5 brand kits, unlimited designs |

* Every file downloaded counts once (a ZIP of 4 sizes = 4 images). Editing and previewing are unlimited.
* The workspace owner buys **seats**; each team member uses one seat and gets their own allowance.
* All limits are **editable without code** in *Admin → Plans & pricing* (price, quota, period day/month/lifetime,
  quality, video, batch, watermark, templates, designs, brand kits, upload size, storage). You can add new plans
  (e.g. "Business") and grant complimentary plans to any workspace.

> Note: as specified, Starter (5/day ≈ 150/month for $10) gives more images than Pro (50/month for $20).
> Pro is positioned on features (video, print quality, more brand kits). If you'd rather Pro be the bigger
> allowance, change it in *Admin → Plans* — e.g. Pro = 10/day or 300/month.

---

## 3. Access control

**Roles inside a business workspace**

| Role | Can do |
|---|---|
| Owner | Everything, incl. billing, seats, inviting admins |
| Admin | Invite/remove designers & viewers, see and manage all workspace designs, brand kits |
| Designer | Create, edit, share and download designs; use brand kits |
| Viewer | View designs shared with the team — no editing or downloading |

**Design access (per design):** 🔒 Private · 👁 Team can view · ✏️ Team can edit.
Viewers of a "team can view" design can *Make a copy to edit*.

**Plan-gated features** are enforced on the server (not just hidden in the UI): video uploads/exports,
2×/3× quality, batch export, number of designs, brand kits, upload size and storage.

**Platform admin** (`/admin`): usage & revenue overview, users/workspaces (suspend, unlock, verify email,
reset 2FA, grant plans, promote admins), plan editor, audit log, email outbox. Non-admins get a 404.

---

## 4. Security controls

* Passwords: bcrypt (cost 12), 10+ chars with letter + number, common-password block; constant-time login
  (no account enumeration); password reset links are single-use, expire in 1 hour and sign out all devices.
* Brute-force protection: account lock for 15 min after 5 failed attempts + per-IP rate limits on
  auth (30 / 15 min), API (300 / min) and uploads.
* Optional **2-step verification** (TOTP authenticator apps); secrets encrypted at rest with AES-256-GCM.
* Sessions: random 256-bit tokens stored only as SHA-256 hashes; HttpOnly, SameSite=Lax cookies
  (`__Host-` + Secure in production); 7-day idle / 30-day absolute expiry; view & revoke devices.
* CSRF: per-session token header on every write + same-origin check.
* Headers (Helmet): strict Content-Security-Policy (no inline scripts, no third-party scripts),
  HSTS in production, frame-ancestors none, nosniff, Referrer-Policy, Permissions-Policy.
* Uploads: file type detected from the actual bytes (not the name), per-plan size limits, random
  server-side names, served only to members of the same workspace.
* Every query is parameterised; every input is validated and length-limited; output is HTML-escaped.
* Email verification required before downloading (stops free-trial abuse; switchable).
* Audit log of sign-ins, failures, lockouts, sharing, team, billing and admin actions.

**Honest limitation:** designs are rendered in the user's browser (that's what keeps it fast and cheap).
Every download is authorised and counted by the server first, and trial downloads are watermarked, but a
technically skilled user could still screenshot the preview or use browser dev-tools. If that ever matters,
the next step is server-side rendering of the final file (e.g. `@napi-rs/canvas`) so clean images only
ever come from the server.

---

## 5. Going live checklist

1. Set `NODE_ENV=production`, `APP_URL=https://yourdomain.com`, a long random `APP_SECRET`, and `TRUST_PROXY=1`
   if behind a proxy. Run behind HTTPS (Nginx/Caddy/Cloudflare, or a host like Render/Railway/a VPS).
2. **Admin 2-step login:** log in as the platform admin → *Account & security* → turn on 2-step verification.
   The admin area stays locked until you do (`REQUIRE_ADMIN_2FA=true`).
3. **Email:** add SMTP details (SendGrid, Mailgun, Amazon SES, Zoho, Google Workspace…) and `SUPPORT_EMAIL`.
4. **Payments:** Stripe needs 4 recurring per-unit prices (Starter $10/mo, $100/yr; Pro $20/mo, $200/yr) →
   `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_STARTER_ANNUAL`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_PRO_ANNUAL`.
   Webhook: `https://yourdomain.com/api/billing/webhook` for `checkout.session.completed`,
   `customer.subscription.created|updated|deleted`, `invoice.payment_failed` → `STRIPE_WEBHOOK_SECRET`.
   ⚠️ Stripe does not accept businesses registered in Nepal — see the Launch Kit for options.
5. **Backups:** automatic daily. Set `BACKUP_S3_*` for an off-site copy, then run **one restore test**:
   `npm run backup` then `npm run backup:verify` (or *Platform admin → Backups & errors → Run restore test*).
6. **Uptime:** add a free UptimeRobot HTTP monitor for `https://yourdomain.com/health` (every 5 min, email/SMS alert).
7. **Errors:** browser + server errors appear in *Backups & errors*. Optional Sentry: set `SENTRY_DSN`, run `npm install @sentry/node`.
8. Add your Terms of Service and Privacy Policy pages (signup asks users to accept them).
9. Test on a real iPhone (Safari) and a real Android phone (Chrome) — see section 10.

---

## 6. Project layout

```
server/            Express app
  index.js         security headers, rate limits, routing, first-run admin
  config.js        environment settings
  db.js            SQLite schema + seed plans
  security.js      passwords, sessions, CSRF, roles, 2FA, audit log
  plans.js         plan entitlements + quota counting
  routes/          auth, designs, media, workspace (brand kits/exports/team), billing, admin
views/             HTML pages (landing, auth, dashboard, editor, admin)
public/            CSS + browser JS (editor.js = the canvas engine)
tests/api.test.js  end-to-end API tests
data/              created at runtime (database, uploads) — not committed
```

---

## 7. Changes to the original editor (review findings fixed)

* The chosen **brand colour was never applied** to designs — it now overrides the theme accent (with an "A" = theme default option).
* The saved logo was stored as a temporary `blob:` URL in localStorage, so it **disappeared after a reload** — logos and photos are now uploaded and saved with the design and brand kit.
* The export format labelled **"MP4" actually produced WebM** — now labelled "Video (WebM)".
* The headline's last line could **overlap the subheadline** — spacing fixed.
* Subheadline and contact line **couldn't be hidden** in Layers — toggles added.
* Clicking the upload box could **open the file picker twice** — fixed.
* The corner-colour background remover (failed on gradients, shadows, low contrast and busy photos) was replaced — see section 8.
* JSZip loaded from a CDN — now served locally so the strict CSP can block all third-party scripts.
* Batch export now defaults to the 4 most-used sizes so small daily allowances aren't used up in one click.

---

## 8. Background remover (Cut-out Studio)

Runs entirely in the customer's browser (a background thread, so the editor never freezes) — no AI service and no per-image cost.

**One click:** the *Remove background* switch picks the right method automatically:
* **Plain / studio backdrops** (white, grey, coloured paper, gradients, two-tone wall + table): edge-aware flood fill from the photo border with a multi-colour backdrop model, adaptive to how noisy the backdrop is.
* **Busy backdrops** (wooden tables, shop shelves, fabric): GrabCut graph-cut segmentation.

**✨ Refine opens the Cut-out Studio:**
* *Subject box* — drag a box around the product for difficult photos.
* *Keep* / *Erase* brushes, *Magic erase* (click leftover background), Undo/Redo (Ctrl+Z / Ctrl+Y), brush size with `[` `]`.
* Sliders: removal strength, edge softness, shrink/grow edge, remove loose bits; switches for backdrop shadows, gaps & handles, and colour-fringe cleaning.
* Preview as Result / Show removed / Original, on checkerboard, white, black or brand colour, with zoom.

**In the design:** backdrop behind the cut-out (theme colour, gradient, spotlight, blurred original photo) and an optional soft drop shadow. The final cut-out is built at up to 2400 px so HD/print exports stay sharp, and the mask is saved with the design (reopening keeps all touch-ups).

**Tested accuracy** (overlap with the true outline, 7 typical product photos): old method 43% → new 94%. The old method failed completely on gradient, low-contrast, two-tone and handle-hole photos. `npm test` includes these checks.
Limits: a subject that is the *same colour* as the backdrop with no visible edge (e.g. a white label touching a white backdrop) needs a quick *Keep* brush stroke.

---

## 9. Move & resize anything (promo and customer-review posts)

Every element can be placed exactly where the photo needs it:
* **Promo:** badge, headline, subheadline, price / offer, call-to-action button, contact line, logo, and the product cut-out.
* **Customer review:** quote mark, star rating, review text, customer name, verified badge, logo, and the product cut-out.

How:
* **Drag** it on the design (it snaps to the centre lines; hold Alt to stop snapping). **Drag the round corner handle** to make it bigger or smaller.
* Or select it via the **✥ Move** buttons next to each field (Offer / Review details, Badge) or by clicking its row in the **Layout** tab, then use the **arrow pad**, **Left↔Right / Up↕Down / Size sliders**, or one-click **Line up** (left, centre, right, top, middle, bottom).
* Keyboard: arrow keys nudge (Shift = bigger steps), Esc deselects, Delete resets the element. Double-click text on the design to jump to its input field.
* **Reset this** / **Reset all positions** go back to the automatic layout.

Positions are stored as percentages of the canvas, so they carry over to every platform size and to batch exports, and are saved with the design. When text is moved into the top half of a photo, a soft shade is added behind it automatically so it stays readable.


---

## 10. Launch-readiness features

**Video → MP4.** Recorded videos are converted on the server to H.264/AAC MP4 (the format Instagram, Facebook
and TikTok expect) using the bundled `ffmpeg-static`. If the conversion tool is missing the app falls back to the
browser's own MP4 recording (Safari) or WebM.

**Your data & account deletion.** *Account & security → Download my data* gives a ZIP of everything held about the
user (account, designs, brand kits, history, uploads). *Delete account* removes the user (and, for an owner, the
whole workspace, files and subscription) after password + "DELETE" confirmation.

**Content.** 14 colour themes, 17 self-hosted fonts, 4 layouts and 77 templates across 15 categories, with live
previews and search in the template library.

**Help & support.** `/help` has a searchable FAQ and a contact form (messages land in *Platform admin → Support inbox*
and are emailed to `SUPPORT_EMAIL`; the customer gets a reference like PF-00012). Optional WhatsApp button via `SUPPORT_WHATSAPP`.

**Closed beta.** Set `BETA_MODE=true`. Create invite codes in *Platform admin → Beta & feedback* (e.g. one code for
20 Eve Zone cafés that gives Pro free for 60 days) and send the sign-up link. Visitors without a code are sent to
the beta application form.

**Feedback & testimonials.** A 💬 Feedback button in the dashboard and editor collects a star rating and comment.
Customers can tick "you may quote this"; only those can be approved, and approved quotes appear on the home page.

**Landing page.** 30-second demo video (`public/media-site/demo.mp4`, recorded from the real app), before/after
examples (replace the built-in samples by uploading real customer examples in *Platform admin → Home page examples*),
SEO basics (title/description, canonical, Open Graph + Twitter preview image, JSON-LD, `sitemap.xml`, `robots.txt`)
and cookie-free analytics (*Platform admin → Site analytics*; no cookie banner needed).

**Reliability.** `/health` checks the database and disk space. Daily backups (database snapshot + incremental
uploads, 14 kept, optional S3/R2 copy). Restore: stop the app, `npm run restore -- latest`, start again.

**Phones.** On phones the preview stays pinned at the top while you edit below; text can be dragged with a finger.
Tested in emulation on iPhone 13, iPhone SE, Pixel 7 and Galaxy S9+ (no sideways scrolling, upload, templates,
touch-drag and download all work). Emulation uses Chrome's engine, so still check a real iPhone in Safari:
open the site, sign up, upload a photo from the camera roll, download, and post it to Instagram.

---

## 11. Put it online (GitHub + Render)

PostForge is an always-on server with a database and uploaded photos on disk, so it needs a host with a
**persistent disk**. Vercel and Netlify only run short-lived serverless functions with no lasting disk,
so the database and uploads would be lost — they are not suitable. Render (or Railway / a VPS) is.

1. Put the code on GitHub (private repository) with **GitHub Desktop**: *File → Add local repository* →
   choose this folder → *Publish repository* (keep "Keep this code private" ticked).
   `.env` and `data/` are excluded automatically, so passwords and customer data are never uploaded.
2. On render.com: *New → Blueprint* → connect GitHub → pick the repository. Render reads `render.yaml`
   and creates the web service, a 5 GB disk and a random `APP_SECRET`.
3. Fill in the settings it asks for: `APP_URL` (e.g. `https://postforge.onrender.com`, later your own
   domain), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SUPPORT_EMAIL`. Add SMTP and backup (`BACKUP_S3_*`) settings
   under *Environment* when ready.
4. Every time new code is pushed to GitHub, Render redeploys automatically (about a minute of downtime).

## 12. Put it online with Fly.io (alternative to Render)

Cheaper for a small private team: the server sleeps when nobody is using it and wakes in a few seconds.
Fly.io needs a card after its short free trial and bills by use.

* **First time:** double-click `fly-setup.cmd`. It installs the Fly.io tool, opens your browser to sign in,
  creates the app and a 1 GB permanent disk in Singapore, asks for the admin login, and publishes the site at
  `https://<app-name>.fly.dev`.
* **After changes:** double-click `fly-update.cmd`.
* Settings live in `fly.toml` (region, memory, `BETA_MODE`). Secrets are set with `fly secrets set NAME=value`.
* Fly also takes a daily snapshot of the disk (kept 5 days) on top of PostForge's own backups.

## 13. Social media posting (Facebook Pages + Instagram)

Open a design → **📣 Post** → tick accounts → caption → **Post now** or **Schedule**. Scheduled posts, history,
retries and connected accounts live under **Social posts** in the dashboard. Each post counts as one download.

* **Connecting** uses Meta's own login pop-up (OAuth). People type their password on facebook.com — PostForge only
  receives Page tokens for the Pages/Instagram accounts they tick, stored encrypted.
* **Demo mode** (no `META_APP_ID`): connecting adds sample accounts and posts are simulated, so the team can try the flow.
* **Real posting:** create a Meta app (use cases *Manage everything on your Page* + *Manage messaging & content on
  Instagram*), add the redirect URI `https://YOUR-SITE/api/social/meta/callback` under Facebook Login for Business →
  Settings, set the Privacy Policy URL to `https://YOUR-SITE/privacy`, then set `META_APP_ID` / `META_APP_SECRET`
  (on Fly.io: double-click `fly-connect-meta.cmd`). Permissions used: pages_show_list, pages_read_engagement,
  pages_manage_posts, instagram_basic, instagram_content_publish, business_management.
* While the Meta app is unpublished/standard access, only people with a role on the app (you, your team) can connect
  and their posts may only be visible to app roles. To let customers connect their own Pages, publish the app and
  complete Meta **App Review** + **Business Verification** for the permissions above.
* **Instagram** needs PostForge online (Instagram downloads the post from `APP_URL/pub/...`), Business/Creator
  accounts linked to a Page, feed images between 4:5 and 1.91:1 (taller designs go to Stories; videos become Reels).
* Scheduled posts are published by the server every 30 seconds — on Fly.io the machine is kept always on for this.
* **Going back to v1.0:** the version before this feature is saved as Git tag `v1.0-before-social` and as zips in
  `_backups/`. The new database tables are additive, so v1.0 runs fine on the same data.
