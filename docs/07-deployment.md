# 07 — Deployment: from nothing to taking orders

This guide takes Shipnod from this repository to a live server at your own domain. It covers HTTPS, real SMS, payments and continuous off-site backups. Plan on about two hours of work, plus waiting time for things other companies approve (SMS sender ID, SSLCommerz merchant account).

```
 sellers & customers ──HTTPS──► Caddy ──► Shipnod app ──► SQLite (Docker volume)
                     (certificates auto-renewed)             │
                                              Litestream ◄───┘ every change, within ~1 s
                                                   │
                                                   ▼
                                     S3-compatible bucket (Cloudflare R2 / Backblaze B2)
```

Everything runs from `compose.yaml` in the repo root. The stack was rehearsed end to end:

- production mode behind Caddy;
- SMS through an HTTP gateway (a stand-in with the same responses as a real one);
- backup to an S3 API;
- a restore drill;
- automatic recovery onto an empty server;
- a restart while the backup service was down;
- a rollback to a snapshot.

The parts that can only be checked with your own accounts are your SMS gateway's exact URL format, your bucket's endpoint and SSLCommerz's live API. Each has a test step below.

---

## 0. Shopping list

| You need | Why | Options | Rough cost (check current prices) |
|---|---|---|---|
| A short domain | HTTPS, and it appears in every SMS link | Any registrar (Cloudflare, Namecheap, Porkbun…). `.com.bd` through BTCL takes longer | ≈ $10–15 / year |
| A VPS | Runs everything | Ubuntu 24.04 LTS, 1 vCPU, 1–2 GB RAM, 25 GB disk, **Singapore or Mumbai** region (closest to Bangladesh): DigitalOcean, Vultr, Akamai/Linode, AWS Lightsail | ≈ $6–12 / month |
| A card that pays in USD | VPS and domain bills | Dual-currency or virtual card from your bank | — |
| A Bangladeshi SMS gateway with an HTTP API | Login codes, order confirmations, reminders | Compare a few (e.g. BulkSMSBD, Alpha SMS, Greenweb, SSL Wireless) on price, delivery and support. These are examples, not endorsements | Prepaid, per SMS (the plan assumes ৳0.30–0.60) |
| An S3-compatible bucket | Off-site backups | Cloudflare R2 or Backblaze B2 (both have free tiers that cover this) | ≈ $0 |
| Later: an SSLCommerz merchant account | Online payments (bKash, Nagad, cards) | sslcommerz.com. Needs a trade license and a bank account | Fee per transaction |

**Start the slow approvals now:** a masked sender ID (your brand name as the SMS sender) from your SMS provider, and the SSLCommerz merchant account. You can go live without either. Use a non-masked (numeric) sender and manual bKash/Nagad payments, and switch over when they're approved.

---

## 1. Create the server

1. **SSH key** (on your own computer, once):
   ```bash
   ssh-keygen -t ed25519 -C "you@shipnod"      # press Enter for the defaults
   cat ~/.ssh/id_ed25519.pub                    # paste this into the VPS provider
   ```
2. **Create the VPS:** Ubuntu 24.04 LTS (x64), Singapore or Mumbai, 1–2 GB RAM, with your SSH key added. Note its public **IPv4 address**.
3. **Provider firewall:** if your provider has a cloud firewall, allow inbound TCP 22, 80, 443 and UDP 443.

## 2. Point the domain at it

At your DNS provider add an **A record**: name `@` (or a subdomain), value = the VPS IP, TTL 300. If you use Cloudflare DNS, set the record to **DNS only** (grey cloud) so Caddy can get its certificate directly.

Check from your computer. It must print the VPS IP before step 8 can get a certificate:
```bash
dig +short yourdomain.com
```

## 3. Secure the server (15 minutes)

```bash
ssh root@YOUR_SERVER_IP

# A normal user for daily work, with your SSH key
adduser deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys

# Keys only, no root login. A file that sorts first wins over the cloud-init defaults in the same folder.
printf 'PasswordAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/00-hardening.conf
systemctl restart ssh

# Firewall: SSH + web only
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable

# Security updates install themselves
apt update && apt -y upgrade && apt -y install unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

# 2 GB swap: headroom for building the image on a 1 GB server
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

**Before closing this window,** open a second terminal and check that `ssh deploy@YOUR_SERVER_IP` works. Then use `deploy` from now on.

## 4. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
exit                                    # log out and back in so the group applies
ssh deploy@YOUR_SERVER_IP
docker compose version                  # should print a version
```

Docker opens its published ports itself, bypassing `ufw`. The stack publishes only 80 and 443, which are open anyway. The app's own port is internal-only.

## 5. Get the code

The repository is private, so give the server a **read-only deploy key**:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/shipnod_deploy -N ""
cat ~/.ssh/shipnod_deploy.pub
```

On GitHub go to the repo → **Settings → Deploy keys → Add deploy key**, paste the key and leave write access **off**. Then:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-shipnod
  HostName github.com
  IdentityFile ~/.ssh/shipnod_deploy
EOF
git clone git@github-shipnod:zariffromlatif/shipnod.git
cd shipnod
```

## 6. Create the backup bucket

Create a **private** bucket and an access key that can only read and write that bucket.

- **Cloudflare R2:**
  1. Create a bucket (e.g. `shipnod-backups`).
  2. Create an R2 API token with object read & write access to that bucket.
  3. Note the Access Key ID, the Secret Access Key, and the S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
  4. Use `region auto`.
- **Backblaze B2:**
  1. Create a private bucket.
  2. Create an application key restricted to that bucket.
  3. The bucket page shows the endpoint, e.g. `https://s3.us-west-004.backblazeb2.com`. The region is the middle part (`us-west-004`).

## 7. Set up the SMS gateway

1. Open an account and top up a small balance.
2. Start with a **non-masked** (numeric) sender ID. Apply for a **masked** one (your brand) in parallel and change `SMS_SENDER_ID` when it's approved.
3. **Allowlist your VPS IP** in the gateway dashboard, or switch its IP allowlist off. Many Bangladeshi gateways reject API calls from unknown IPs, and that's the most common reason SMS "doesn't work".
4. From the gateway's API docs, find the send-SMS URL and build `SMS_HTTP_URL` with these placeholders. Values are URL-encoded automatically.

   | Placeholder | Becomes |
   |---|---|
   | `{apiKey}` / `{senderId}` | `SMS_API_KEY` / `SMS_SENDER_ID` |
   | `{to}` / `{toLocal}` | `8801XXXXXXXXX` / `01XXXXXXXXX` |
   | `{text}` | the message |
   | `{type}` | `unicode` for Bangla messages, `text` otherwise |
   | `{unicode}` | `1` for Bangla, `0` otherwise |

   If the gateway needs a flag for Bangla text, use `{type}` or `{unicode}` under the parameter name its docs give. Without one, Bangla arrives as `????`.
5. Note what a **successful** response looks like. Set `SMS_HTTP_SUCCESS_PATTERN` to a regex that only matches success: many gateways answer HTTP 200 even when the SMS was rejected. Step 8 shows the gateway's raw answer so you can check.

## 8. Configure and start

```bash
cp deploy/env.production.example .env
openssl rand -hex 32        # → NETWORK_HASH_SECRET
openssl rand -hex 32        # → APP_ENCRYPTION_KEY
openssl rand -base64 24     # → ADMIN_PASSWORD
nano .env                   # fill in every section; the comments explain each value
chmod 600 .env
```

> **Keep a copy of `.env` in your password manager.** It is the one thing the backups don't contain.
> Never change `APP_ENCRYPTION_KEY`: courier logins are encrypted with it.
> Never change `NETWORK_HASH_SECRET`: all shared delivery history is keyed by it.

Start everything:

```bash
docker compose up -d --build
docker compose ps
```

What you should see: `restore` **Exited (0)**, `app` **Up (healthy)**, and `caddy` and `litestream` **Up**. Then:

```bash
docker compose logs caddy | grep -i certificate       # "certificate obtained successfully"
curl https://yourdomain.com/health                     # {"ok":true}
docker compose logs litestream | tail -5               # "snapshot written" … "wal segment written"
docker compose exec app node dist/cli/sms-test.js 01XXXXXXXXX     # your own phone
```

`sms-test` sends an English and a Bangla message and prints each gateway answer. Both must arrive, and the Bangla one must be readable.

If anything is off, see [Troubleshooting](#troubleshooting).

## 9. First-day checklist

1. **Admin:** open `https://yourdomain.com/admin` and log in with `ADMIN_PASSWORD`.
2. **A test shop for yourself:** in `/admin`, tap **+ নতুন বিক্রেতা**. Enter your own name and number, choose Growth, and clear "পাইলট (দিন)" so it never expires. Leave "লগইন লিংক SMS করুন" ticked. The welcome SMS with the login link should arrive on your phone.
3. **Seller login:** open the link from that SMS (`https://yourdomain.com/app/login`), enter your number, and use the SMS code. This proves login SMS works.
4. **A real order:** under **+ নতুন অর্ডার**, enter a second phone you own as the customer. Open the confirmation SMS on that phone and confirm. The order turns "কনফার্মড".
5. **Billing without spending money:**
   1. In **বিলিং**, pick a plan.
   2. Submit a made-up TrxID under Send Money.
   3. Reject it in `/admin`.
   4. Check that the rejection SMS arrives.
6. **Monitoring:** add an uptime check (UptimeRobot, Better Stack…) on `https://yourdomain.com/health` every 5 minutes, with alerts to your phone.
7. **First pilot seller.** From your phone, even during the sales call:
   1. In `/admin`, tap **+ নতুন বিক্রেতা**.
   2. Enter the owner's name, the shop name and their mobile number. Keep Growth and 14 days.
   3. Submit. They get an SMS with the login link right away. If it doesn't arrive, tap **WhatsApp-এ পাঠান** to send the same message from your WhatsApp.

   They log in with their own phone and an SMS code, so they never need the API key shown on that page (it's only for connecting their own systems).

   After 14 days the renewal SMS start, and they pay at **বিলিং**. You approve bKash/Nagad payments in `/admin`.

   The command-line equivalent is `docker compose exec app node dist/cli/create-seller.js --name "Owner" --shop "Their Shop" --phone 01THEIRNUMBER --plan growth --trial-days 14 --welcome`.

## 10. Turn on SSLCommerz

1. **Sandbox first:**
   1. Register a sandbox store at developer.sslcommerz.com.
   2. In `.env` set `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD` and `SSLCOMMERZ_SANDBOX=true`.
   3. Run `docker compose up -d`.
   4. On an invoice, choose **অনলাইনে পেমেন্ট** and complete a sandbox payment.
   5. Check that the invoice shows পরিশোধিত and the plan is active.
2. **Live:**
   1. When the merchant account is approved, put the live credentials in `.env` and set `SSLCOMMERZ_SANDBOX=false`.
   2. Run `docker compose up -d`.
   3. Make one small real payment yourself.

The success, fail, cancel and IPN URLs are sent with every payment, so there's nothing else to configure. If the merchant panel asks for an IPN URL, use `https://yourdomain.com/billing/sslcommerz/ipn`.

> After **any** `.env` change run `docker compose up -d`. `docker compose restart` does **not** reload `.env`.

## 11. Day-to-day

| Task | Command |
|---|---|
| Status | `docker compose ps` |
| App logs | `docker compose logs --tail 100 -f app` (logs rotate at 10 MB × 5 per service) |
| New seller | `/admin` → **+ নতুন বিক্রেতা**, or `docker compose exec app node dist/cli/create-seller.js --name … --shop … --phone 01… --plan growth --trial-days 14 --welcome` |
| Pilot / comp / change a plan | `/admin` → বিক্রেতা → set plan |
| Check SMS | `docker compose exec app node dist/cli/sms-test.js 01…` |
| Local snapshot | `docker compose exec app node dist/cli/snapshot.js` → `/data/snapshots/…` |
| Disk space | `df -h` (monthly) |

## 12. Updating to a new version

```bash
cd ~/shipnod
docker compose exec app node dist/cli/snapshot.js      # safety copy; note the file name it prints
git pull
docker compose up -d --build
docker compose ps                                       # app healthy again after ~15–30 s
```

Database migrations run automatically when the app starts. Expect roughly 15–30 seconds of downtime while the app restarts.

**Rolling back:**

- **The update had no new database migration** (check `src/db/migrations.ts` in the diff):
  ```bash
  git checkout <previous-commit> && docker compose up -d --build
  ```
- **It did, or data went wrong:** roll back to the snapshot you took. This was rehearsed: the data returns to the snapshot, and Litestream starts a fresh backup history from it.
  ```bash
  docker compose stop app litestream
  docker compose run --rm --no-deps restore "cp /data/snapshots/shipnod-YYYYMMDD-HHMMSS.db /data/shipnod.db && rm -f /data/shipnod.db-wal /data/shipnod.db-shm && chown 1000:1000 /data/shipnod.db"
  git checkout <previous-commit>
  docker compose up -d --build
  ```

## 13. Backups and disaster recovery

**What's protected:** the whole database (sellers, orders, payments, invoices, delivery history) is streamed to your bucket within about a second of every change. The bucket keeps 7 days of point-in-time history and takes a fresh snapshot daily.

**Not in the bucket:**
- `.env`: keep it in your password manager.
- HTTPS certificates: Caddy simply requests new ones.

**Monthly restore drill.** It takes a minute and doesn't touch live data:
```bash
docker compose run --rm --no-deps litestream restore -o /data/restore-test.db /data/shipnod.db
docker compose exec app node --disable-warning=ExperimentalWarning -e '
  const { DatabaseSync } = require("node:sqlite");
  const d = new DatabaseSync("/data/restore-test.db", { readOnly: true });
  console.log(d.prepare("select (select count(*) from sellers) sellers, (select count(*) from orders) orders, (select count(*) from invoices) invoices").get(),
              d.prepare("pragma integrity_check").get());'
docker compose exec app sh -c 'rm -f /data/restore-test.db*'
```
The counts should match the live numbers you see in `/admin`, and `integrity_check` should say `ok`.

**If the server dies:**
1. Create a new VPS (steps 1, 3, 4, 5).
2. Copy the same `.env` from your password manager.
3. Run `docker compose up -d --build`.
4. Point the DNS A record at the new IP.

The `restore` step sees an empty server and pulls the latest database from the bucket before the app starts. This was rehearsed on empty volumes: everything came back, including sellers' logins and API keys.

<a id="troubleshooting"></a>
## 14. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `docker compose up` says `required variable … is missing a value` | That `.env` value is empty. Fill it in. Backups and the domain are deliberately required. |
| `app` keeps restarting | `docker compose logs app`. The first lines say what's wrong, e.g. a secret missing or too short, `APP_ENCRYPTION_KEY must be 64 hex characters`, `SMS_PROVIDER=console is not allowed in production`, or an invalid bKash number. |
| `restore` exited with an error, so `app` won't start | Backup settings are wrong (endpoint, region, keys, bucket name). `docker compose logs restore`. Routine restarts don't need the bucket, only a first start on an empty server does. |
| No HTTPS certificate | DNS doesn't point here yet (`dig +short yourdomain.com`), ports 80/443 are blocked in the provider's cloud firewall, or Cloudflare's proxy (orange cloud) is on. `docker compose logs caddy` gives the exact reason. |
| `sms-test` says FAIL | Read the gateway answer it prints. Common causes: the server IP isn't allowlisted, there's no balance, the sender ID is wrong, or the success pattern doesn't match the real success response. (BulkSMSBD-style codes: 1032 IP not allowed, 1007 balance, 1002 sender ID.) |
| Bangla SMS arrives as `????` | The gateway needs a Unicode flag. Add `{type}` or `{unicode}` under the parameter name its docs use. |
| Login code never arrives | Same checks as SMS. Run `sms-test` to the same number. |
| Changed `.env` but nothing changed | Use `docker compose up -d`. `restart` keeps the old environment. |
| Server feels slow or the build is killed | 1 GB RAM without swap: add the swap from step 3, or move to 2 GB. |

## 15. Monthly running cost (approximate)

| Item | Cost |
|---|---|
| VPS (1–2 GB, Singapore/Mumbai) | ≈ $6–12 |
| Domain | ≈ $1 |
| Backup bucket | ≈ $0 on free tiers |
| SMS | Pay as you go. At ৳0.30–0.60 each, about 1–2 SMS per order |
| SSLCommerz | A percentage per online payment (see their current pricing). Manual bKash/Nagad costs only the normal transfer fees |

Fixed costs come to roughly **$7–13 a month (about ৳850–1,600)**. One seller on Growth (৳2,490) covers them.
