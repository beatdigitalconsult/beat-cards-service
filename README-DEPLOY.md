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
     - Instance Type: Free (fine to start; upgrade later for
       always-on speed and a persistent disk — see note below)

4. Under "Environment", add one variable:
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

   IMPORTANT — free tier persistence note: Render's free web
   services use a temporary disk that is wiped on redeploy or
   after long inactivity, so saved cards could be lost. For a
   production launch, either (a) add a paid "Persistent Disk"
   to this service in Render's dashboard and mount it at
   /opt/render/project/src/data, or (b) swap the storage in
   server.js for a real database — the README inside server.js
   marks exactly where (loadDB/saveDB). Either is a quick change
   once you're ready to go fully live; the free tier is great
   for testing the whole flow first.

------------------------------------------------------------
OPTION B — RAILWAY.APP or FLY.IO
------------------------------------------------------------
Both work the same way: point them at this folder (or its own
GitHub repo), Node runtime, "npm install" / "npm start", and set
the ADMIN_KEY environment variable. Both offer persistent
volumes for the data/ folder if you want the simple file-based
storage to survive restarts long-term.

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
------------------------------------------------------------
This almost always means the card was never actually received by
this server — usually because the browser blocked the desktop
app's save/sync request before it left the computer (a CORS
issue), not because anything is wrong with your domain or Render
setup. This version of server.js already includes the fix
(CORS headers + OPTIONS preflight handling) — if you deployed an
earlier copy, just replace server.js with this one, push to
GitHub, let Render redeploy, then:
  1. Open the BMS desktop app → Settings → 🌐 Card Hosting →
     confirm the Hosted Service URL exactly matches your live
     URL (no trailing slash) and Save again.
  2. Open/edit an existing card and click "Save Card" once —
     watch for a toast message. If it says "publish failed" or
     "could not reach the hosted service", it will tell you why.
  3. Re-scan the QR code (or reopen the card's public link).

Other things worth checking:
  • Visiting https://<your-domain>/healthz should return JSON
    with "ok": true.
  • On Render's free tier, the service can "sleep" after periods
    of no traffic and take a few seconds to wake up on the first
    request — this is normal, just wait and try again.
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
