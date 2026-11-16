# Lending app

An app for a licensed Malaysian moneylender. It has two parts:

- **Borrower app** (`/`): an installable web app (PWA). Borrowers choose the amount, repayment period, how often they pay (weekly, every 2 weeks or monthly) and the repayment style. They see the full cost, apply, log in with their phone number and a 6-digit PIN, view their schedule and payment instructions, and get reminders.
- **Admin panel** (`/admin`): approve or reject applications, pay out loans, record payments (partial payments are fine), manage loan products and rates, send or schedule reminders, set up automatic reminders, connect the Meta Pixel and Conversions API and the TikTok Pixel and Events API, set up S2S postbacks, and view an event log showing every request and response.

Stack: Node.js 22, Express 5 and SQLite (one file in `./data`). There is no build step. The frontend is plain JavaScript.

---

## Deploy on a VPS (Docker, recommended)

These steps are written so Claude Code on the server can follow them.

1. **DNS**: add an A record for the domain (e.g. `pinjaman.yourcompany.com`) pointing to the server's IP.
2. **Open ports** 80 and 443 on the server firewall.
3. Clone and configure:
   ```bash
   git clone <this repo> lendapp && cd lendapp
   cp .env.example .env   # then edit: PUBLIC_DOMAIN, ADMIN_PASSWORD, VAPID_EMAIL
   docker compose up -d --build
   ```
4. Open `https://<your domain>/admin` and log in with `ADMIN_USER` / `ADMIN_PASSWORD`. **Change the password in Settings.**
5. In the admin panel → **Settings**, fill in the company name, KPKT licence number, phone, domain and bank details.

Caddy obtains the HTTPS certificate automatically. HTTPS is required for installing the app and for push notifications.

**Updates:** `git pull && docker compose up -d --build`
**Logs:** `docker compose logs -f app`
**Backups:** everything is in `./data/lendapp.db`. Copy it somewhere safe every day, for example with a cron job:
`0 3 * * * cd /path/to/lendapp && sqlite3 data/lendapp.db ".backup data/backup-$(date +\%F).db"`

### Without Docker
```bash
npm ci --omit=dev
cp .env.example .env && set -a && . ./.env && set +a
node server.js            # or: pm2 start server.js --name lendapp
```
Then put Nginx or Caddy in front of port 3000 with HTTPS.

---

## Setting up the integrations

### Meta (Facebook / Instagram)
Admin → **Meta & TikTok**. Paste the **Pixel / Dataset ID** and a **Conversions API access token** (Events Manager → dataset → Settings → Conversions API → Generate access token). Use the test event code while checking events in the Test Events tab, then delete it.

- The browser pixel loads in the app automatically.
- The server also sends each event through the Conversions API with the **same event ID**, so Meta deduplicates them.
- Personal data (phone, email, name) is SHA-256 hashed. `fbc`/`fbp` cookies, IP and user agent are passed along to improve matching.

### TikTok
Paste the **Pixel code** and an **Events API access token** (Ads Manager → Tools → Events → pixel → Settings). As with Meta, the browser pixel and the server events share event IDs. `ttclid` and `_ttp` are captured automatically.

### Default event mapping (editable)
| Step in the app | Meta | TikTok | Value |
|---|---|---|---|
| Used the calculator | ViewContent | ViewContent | – (browser only) |
| Application submitted | Lead | SubmitForm | loan amount |
| Loan approved | LoanApproved (custom) | CompleteRegistration | loan amount |
| Loan disbursed | Purchase | CompletePayment | loan amount |
| Repayment | – | – | amount paid |

Optimise campaigns on **Loan disbursed** once there's enough volume. That way the platforms look for people who actually get loans, not only people who apply.

### S2S postbacks (affiliates / trackers)
Partners send traffic to `https://<domain>/?click_id={their_macro}&utm_source=<partner>`. The app stores the click ID for 30 days. It also captures `ttclid`, `fbclid`, `clickid`, `cid` and `utm_*`.
Add the partner's postback URL in Admin → **S2S postbacks**, using these macros: `{click_id} {event} {amount} {loan_id} {source} {txid} {currency} {timestamp}`. Use **Test fire** to see the partner's reply.

### SMS / WhatsApp / email reminders
App notifications (web push) work out of the box. Borrowers tap **Turn on** in the app. On iPhone, they must first add the app to the Home Screen.

For SMS, WhatsApp and email, set a **webhook URL** in Admin → Settings. The app POSTs:
```json
{ "channel": "wa", "to": "+60123456789", "phone_local": "0123456789", "email": null,
  "name": "Aisyah Rahman", "message": "Hi Aisyah, …", "loan_ref": "L1001" }
```
with an `X-Webhook-Secret` header. Point it at an n8n or Make workflow, or a small script, that sends through your provider (Twilio, WATI, 360dialog, MoceanAPI, etc.). WhatsApp Business requires pre-approved message templates for reminders sent outside a 24-hour chat window.

### Automatic reminders
These run every 5 minutes after the chosen hour (Malaysia time). Defaults: 3 days before the due date, on the due date, 1 day after a missed payment, and 7 days after (off by default). Each instalment receives each reminder only once.

---

## Built-in rules
- Interest is capped by the server at **18% p.a. unsecured / 12% p.a. secured** and calculated as simple interest only. A product can't offer a plan where the interest would be more than the amount borrowed.
- Applicants must give a valid MyKad number and be **18 or older**. The age is read from the MyKad number. They must also accept a data-processing declaration (PDPA).
- One application can be in progress per borrower at a time.
- The admin panel warns about plans of **3 months or shorter**, because Meta doesn't allow ads for loans repaid in full within 90 days.
- Login is rate-limited. PINs and passwords are hashed with scrypt. Tokens are never sent to the browser.

## Before going live: check with KPKT / your lawyer
- Online lending needs **KPKT approval under the online moneylending guidelines**. This is separate from the normal moneylending licence.
- On Meta, loan ads must use the **Credit special ad category** and target people aged 18+.
- Review the reminder wording, the declaration text and your privacy notice.

## Not included yet (good next steps)
- An online payment gateway (FPX/DuitNow via Billplz, ToyyibPay or Curlec). Right now borrowers pay by bank transfer and staff record the payment.
- Document upload (IC photo, payslips) and e-signing the loan agreement.
- SMS OTP login (the PIN login can be swapped for OTP once an SMS provider is connected).
- Multiple admin users with roles.
