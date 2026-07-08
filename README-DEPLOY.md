========================================================
  BEAT MANAGEMENT SYSTEM — Hosted Digital Card Service
  by Beat Digital Consult
========================================================

WHAT THIS IS
------------------------------------------------------------
A small, always-online web service with one job: give every
Digital Business Card a permanent public link, and show a full
profile page (contact details, Save Contact, Call, Email,
WhatsApp) whenever that link — or the card's QR code — is
opened. It also lets the Beat Digital Consult owner approve or
revoke the Digital Business Card add-on for a specific client,
from anywhere.

This piece MUST be deployed online (it is the "hosted" part of
BMS). Everything else in the BMS desktop app keeps working fully
offline exactly as before — only the card profile pages and the
package approval check need this service and an internet
connection.

I (Claude) wrote and tested this code, but I can't click
"Deploy" for you — I don't have the ability to reach the
internet or create accounts on your behalf. The steps below are
the whole job, and they take about 10 minutes the first time.

------------------------------------------------------------
OPTION A — DEPLOY ON RENDER.COM (recommended, has a free tier)
------------------------------------------------------------
1. Create a free account at https://render.com (sign in with
   GitHub, Google, or email).

2. Put this "hosting-service" folder in its own GitHub repo:
     - Create a new repo, e.g. "beat-cards-service"
     - Upload/push everything inside this folder (server.js,
       package.json, .env.example, data/) to that repo
   (No coding needed — GitHub's "Add file → Upload files" in
   the browser works fine.)

3. In Render: New → Web Service → connect that GitHub repo.
     - Name: beat-cards-service (or anything you like)
     - Runtime: Node
     - Build Command:  npm install
     - Start Command:  npm start
     - Instance Type: Free (fine to start — see "MAKING CARDS
       PERMANENT" below before adding real clients, and
       "ELIMINATING COLD-START DELAYS" for when you're ready to
       upgrade to a paid, always-on instance)

4. Under "Environment", add:
     ADMIN_KEY = <a long random string>
   Generate one on your own computer with Node installed:
     node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   Keep this value secret — it protects the approval endpoints.

5. Click "Create Web Service". Render will build and deploy it.
   When it's done you'll get a URL like:
     https://beat-cards-service.onrender.com

6. Test it: open that URL in a browser — you should see the
   branded "Card Profile Service" page. Then open
     https://beat-cards-service.onrender.com/healthz
   and confirm it replies with JSON showing "ok": true.

   ⚠️ CRITICAL — DO THIS BEFORE ADDING REAL CLIENTS: by itself, this
   deployment WILL lose every card. Read "MAKING CARDS PERMANENT"
   right below and do it now — it takes 5 minutes and is free.

------------------------------------------------------------
MAKING CARDS PERMANENT — REQUIRED FOR REAL USE
------------------------------------------------------------
Render's FREE web services have a completely ephemeral filesystem,
and — unlike paid services — free services CANNOT attach a
persistent disk at all (this is a hard Render platform limit, not
a workaround-able setting). Render can also restart a free service
at any time. Every time that happens, every card saved only to the
local file is gone. This is why cards can look "unstable" — working
right after you resave one, then showing "profile not found" a
short time later: the server restarted in between and lost its
local file.

THE FIX (free, ~5 minutes, and this version of server.js already
supports it — you just need to create the database and set one
environment variable):

1. Go to https://www.mongodb.com/cloud/atlas/register and create a
   free account (no credit card required).
2. Create a free "M0" cluster (this tier is free forever, unlike
   Render's free Postgres which expires after 30 days).
3. Database Access → Add New Database User → set a username and
   password (save these — you'll need them in step 5).
4. Network Access → Add IP Address → "Allow Access From Anywhere"
   (0.0.0.0/0). This is required because Render's servers don't
   have a fixed IP address.
5. Go to your cluster → Connect → "Drivers" → copy the connection
   string. It looks like:
     mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/
   Replace <username> and <password> with the values from step 3.
6. In Render: your service → Environment → Add Environment
   Variable:
     MONGODB_URI = <the connection string from step 5>
7. Render will redeploy automatically. Check your service logs —
   you should see:
     ✅ Connected to MongoDB — cards will now persist permanently across restarts.
   If instead you see a connection error, double-check the
   username/password and that Network Access allows 0.0.0.0/0.
8. Confirm it worked: open https://<your-service-url>/healthz —
   it should show "storage": "mongodb". Publish a test card, wait
   a few minutes, and check the health check again; the card count
   should stay the same (nothing will have been lost).

Without MONGODB_URI set, the server still runs fine using a local
file — useful for quick local testing — but you will see a loud
warning in the logs every time it starts, and cards will not
survive a restart. This is fine for testing, not for real clients.

------------------------------------------------------------
ELIMINATING COLD-START DELAYS (recommended for a paying product)
------------------------------------------------------------
Once MONGODB_URI is set, your cards are safe forever — but Render's
free web service tier still spins down after 15 minutes with no
traffic, and takes 30-60 seconds to wake back up on the next
request. For a product you're charging clients for, either:

  (a) Upgrade the Render web service itself to the paid "Starter"
      instance type (from about $7/month) — this removes spin-down
      entirely, so every scan is instant, 24/7, with no cold starts.
      This is the option we'd recommend once you have real paying
      clients relying on their cards working instantly.

  (b) Stay on the free tier and set up a free external monitor
      (e.g. https://uptimerobot.com or https://cron-job.org, both
      free, no credit card) to ping
        https://<your-service-url>/healthz
      every 5-10 minutes. This keeps the free service awake almost
      all the time, at no cost — though it can still occasionally
      spin down and briefly delay a scan (and Render can restart a
      free service at any time regardless, per their own docs).

Either way, your card DATA is now safe once MONGODB_URI is set —
these two options are purely about response speed/uptime, not data
loss.

------------------------------------------------------------
OPTION B — RAILWAY.APP or FLY.IO
------------------------------------------------------------
Both work the same way: point them at this folder (or its own
GitHub repo), Node runtime, "npm install" / "npm start", and set
the ADMIN_KEY and MONGODB_URI environment variables. Both of these
platforms do offer persistent volumes on their free tiers too, if
you'd rather use that than MongoDB Atlas — but MongoDB Atlas works
identically across every host, so it's the option documented above.

------------------------------------------------------------
CONNECTING YOUR OWN DOMAIN (beatdigital.tech)
------------------------------------------------------------
Yes — you can absolutely put this on your own site, e.g.
"card.beatdigital.tech" or "cards.beatdigital.tech", so every
public card link reads like:
     https://card.beatdigital.tech/c/xxxxxxx

1. In Render (or Railway/Fly): open the service → Settings →
   Custom Domain → Add "card.beatdigital.tech".
   They will show you a target (a CNAME value, something like
   "beat-cards-service.onrender.com").

2. In beatdigital.tech's DNS settings (wherever the domain is
   registered/managed — Namecheap, GoDaddy, Cloudflare, etc.),
   add a CNAME record:
     Type:  CNAME
     Host:  card   (so it becomes card.beatdigital.tech)
     Value: beat-cards-service.onrender.com   (whatever your
            host gave you in step 1)

3. Wait for DNS to propagate (a few minutes to a few hours),
   then Render/Railway will automatically issue a free SSL
   certificate for the domain.

4. Once "https://card.beatdigital.tech" loads the same branded
   page as your onrender.com URL, open the BMS desktop app as
   the Beat Digital owner → Settings → "🌐 Card Hosting", and
   set the "Hosted Service URL" field to:
     https://card.beatdigital.tech
   and the "Admin Key" field to the ADMIN_KEY you set above.
   Save. From then on, every new or edited card (on every
   client's install) will publish to this address automatically.

------------------------------------------------------------
HOW IT CONNECTS TO THE DESKTOP APP
------------------------------------------------------------
  • Every time a card is saved in BMS, the desktop app quietly
    sends it to  POST /api/cards  at your hosted URL (using the
    client's license key to identify their account).
  • The QR code + card link shown in the app then point at
    <hosted URL>/c/<card id> — a permanent, always-current page.
  • The Beat Digital owner approves the Digital Business Card
    add-on per client from Licenses → "🪪 Digital Card Package",
    which calls  POST /api/admin/card-package  here using the
    Admin Key. Each client's app checks
    GET /api/card-package/<their license key>  to know whether
    their cards feature is currently active.
  • If this service is unreachable (e.g. no internet at that
    moment), card saving/editing still works locally in BMS —
    only the public link/QR won't update until the next
    successful sync.

------------------------------------------------------------
TROUBLESHOOTING: Diagnostic shows "Failed to fetch" on
"Load public profile page", or links come out as http:// not https://
------------------------------------------------------------
Fixed as of this version — server.js now includes
app.set('trust proxy', 1), which tells Express to read Render's
X-Forwarded-Proto header so it correctly reports "https" instead
of defaulting to "http" (Render, like most hosts, terminates SSL
in front of your app and forwards plain HTTP internally). If you
deployed an earlier copy of server.js, just replace it with this
one, push to GitHub, and let Render redeploy — no other changes
needed.

------------------------------------------------------------
TROUBLESHOOTING: "Profile not found" after scanning a saved card
(especially if it worked right after saving, then stopped)
------------------------------------------------------------
If a card worked immediately after saving/resaving it, then broke
a short time later — this is almost always the MONGODB_URI issue
described in "MAKING CARDS PERMANENT" above: the server restarted
(Render free tier can do this at any time) and lost every card
that was only in its local file. Set MONGODB_URI and this stops
happening entirely. Check https://<your-domain>/healthz — if
"storage" shows "file-only", that confirms this is the cause.

If a card NEVER worked, not even immediately after saving, the
usual cause is the browser blocking the desktop app's save/sync
request before it left the computer (a CORS issue), not anything
wrong with your domain or Render setup. This version of server.js
already includes the fix (CORS headers + OPTIONS preflight
handling) — if you deployed an earlier copy, replace server.js
with this one, push to GitHub, let Render redeploy, then:
  1. Open the BMS desktop app → Settings → 🌐 Card Hosting →
     confirm the Hosted Service URL exactly matches your live
     URL (no trailing slash) and Save again.
  2. Open/edit an existing card and click "Save Card" once —
     watch for a toast message. If it says "publish failed" or
     "could not reach the hosted service", it will tell you why.
  3. Re-scan the QR code (or reopen the card's public link).

Other things worth checking:
  • Visiting https://<your-domain>/healthz should return JSON
    with "ok": true, and "storage": "mongodb" once you've set
    MONGODB_URI.
  • On Render's free tier, the service can "sleep" after periods
    of no traffic and take 30-60 seconds to wake up on the first
    request — this is normal (see "ELIMINATING COLD-START DELAYS"
    above), just wait and try again, or use the paid Starter tier
    to remove this entirely.
  • Make sure the Digital Business Card add-on is actually
    approved for the account you're testing with (Licensing →
    🪪), unless you're signed in as the Beat Digital owner, who
    always has access.

------------------------------------------------------------
SUPPORT
------------------------------------------------------------
  Email:  admin@beatdigital.tech
  Phone:  +233-20-444-9280

========================================================
  © 2026 Beat Digital Consult. All rights reserved.
  Beat Management System — Hosted Card Service
========================================================
