# Stellar MD Editor

A refreshingly simple, lightweight editor for `.txt` and `.md` files in Google Drive.
Free for life. Published by VedAIspace ([vedaispace.com](https://vedaispace.com)).

```
Google Drive
   ↓
Right click file.md
   ↓
Open with → Stellar MD Editor
   ↓
┌────────────────────────────────────┐
│ article.md                    Save │
├────────────────────────────────────┤
│ # My article                       │
│                                    │
│ Some markdown here...              │
└────────────────────────────────────┘
```

- **Minimal permissions**: only `drive.file`, so the app can *only* see files you open with it.
- **No servers**: a static page; your text goes straight from your browser to Google Drive.
- **No tracking**: no analytics, no cookies, no accounts.
- **Tiny**: vanilla HTML/CSS/JS, no framework, no build step, < 20 KB.

Features: edit, Save / `Ctrl+S`, rename (click the filename), unsaved-changes indicator and
close warning, word/char count, dark mode, read-only detection, "New file" from Drive's
New menu, shared-drive support.

## Repository layout

```
public/           the whole app (static files, no build)
  index.html      landing / auth gate / editor views
  app.js          all logic (auth, Drive REST, editor) - set CLIENT_ID here
  style.css       light + dark theme
  privacy.html    privacy policy  (required for verification & listing)
  terms.html      terms of service (required for listing)
Dockerfile        Caddy image serving public/ (how Railway runs it)
Caddyfile         listens on $PORT, gzip, basic security headers
CLAUDE.md         project spec & constraints
```

## Local development

No build, no dependencies:

```
npx serve public
# or: python -m http.server 3000 -d public
```

**Preview with no Google setup:** `http://localhost:3000/?demo=editor` shows the editor
with a sample document (saving and renaming work locally, nothing leaves the browser), and
`http://localhost:3000/?demo=landing` shows the landing page. This is also how the
Marketplace screenshots are taken.

**Real Drive testing:** OAuth only works from whitelisted origins, so add your local origin
(e.g. `http://localhost:3000`) to the OAuth client (step 3 below). To simulate Drive
opening a file, visit:

```
http://localhost:3000/?state={"ids":["<A_REAL_FILE_ID>"],"action":"open"}
```

(the file must be one this app created, or one you have opened with the app before;
the `drive.file` scope only grants access to such files).

## Deployment & Google setup

### 1. Host the app (GitHub → Railway → Cloudflare DNS)

Target URL: `https://md.vedaispace.com/`, referred to below as `APP_URL`. Same platform as
the main vedaispace.com site (Railway), same DNS (Cloudflare).

1. Push this repo to GitHub. Railway works with private and public repos alike.
2. Railway → **New Project → Deploy from GitHub repo** → pick this repo. Railway detects
   the `Dockerfile` (Caddy serving `public/`) and deploys. Every push to the default
   branch auto-deploys from then on.
3. Open the generated `*.up.railway.app` URL and confirm the landing page loads.
4. Railway service → **Settings → Networking → Custom Domain** → add `md.vedaispace.com`.
   Railway shows a CNAME target.
5. Cloudflare → DNS for vedaispace.com → add record: **CNAME**, name `md`, target = the
   value Railway showed. Keep it **DNS only** (grey cloud) until Railway shows the domain
   as verified with a certificate issued. After that you may switch the record to Proxied
   (orange cloud); if you do, set Cloudflare SSL/TLS mode to **Full (strict)**, never
   Flexible, or you'll get redirect loops.

Cost note: the Caddy container is tiny (a few MB of RAM), so it consumes almost nothing
from the Railway plan you already pay for.

### 2. Google Cloud project

1. [console.cloud.google.com](https://console.cloud.google.com) → create project `stellar-md-editor`.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. Also enable **Google Workspace Marketplace SDK** (for publishing, step 6).

### 3. OAuth consent screen + client

1. **APIs & Services → OAuth consent screen**: External. App name "Stellar MD Editor",
   support email, logo (120×120), links to `APP_URL`, `APP_URL/privacy.html`,
   `APP_URL/terms.html`. Authorized domain = `vedaispace.com`.
2. Scopes: add `https://www.googleapis.com/auth/drive.file` and
   `https://www.googleapis.com/auth/drive.install`. Both are **non-sensitive**: no
   security assessment (CASA) is needed, only standard brand verification.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorized JavaScript origins: `APP_URL` origin (+ `http://localhost:3000` for dev).
   No redirect URIs needed (token flow uses a popup).
4. Copy the client ID into `CLIENT_ID` at the top of [public/app.js](public/app.js). Redeploy.
5. Publish the consent screen to **Production** and submit for brand verification
   (needed before public users can sign in without the "unverified app" warning).

### 4. Drive UI integration ("Open with" menu)

**APIs & Services → Google Drive API → Manage → Drive UI integration** tab:

| Field | Value |
|---|---|
| Application name / descriptions | Stellar MD Editor: a refreshingly simple editor for .txt and .md files |
| Application icons | 256/128/64/32/16 px PNGs |
| Open URL | `APP_URL` (Drive appends the `state` query parameter) |
| Default MIME types | `text/plain`, `text/markdown`, `text/x-markdown` |
| Default file extensions | `txt`, `md`, `markdown`, `text` |
| Creating files ("New" menu) | optional: check it and set New URL to `APP_URL` |

### 5. Test before publishing

On the **Google Workspace Marketplace SDK → App Configuration** page: set app visibility
to *Private/unlisted*, app integration = *Drive app*, add the same scopes, then use the
SDK's install link to install for your own account. In Drive, right-click a `.md` file →
Open with → Stellar MD Editor. Verify: open, edit, save, rename, Ctrl+S, dirty-flag warning,
read-only file, "New" menu, dark mode.

### 6. Publish to Google Workspace Marketplace

**Marketplace SDK → Store Listing**: developer name **VedAIspace**, category (e.g.
Productivity / Office Applications), detailed description, graphics (128×128 icon, 220×140
card banner, at least one 1280×800 screenshot), support links (`APP_URL`, privacy, terms,
`https://vedaispace.com`), distribution = Public, pricing = Free. Submit for review
(typically a few days to ~2 weeks).

### Pre-publish checklist

- [x] `CLIENT_ID` set in `public/app.js`
- [x] Contact email set in privacy.html and terms.html (info at the publisher domain, JS-assembled to deter scrapers)
- [ ] Icons + screenshots created
- [ ] OAuth consent screen verified (brand verification)
- [ ] Tested end-to-end from Drive with a second Google account

## Permissions story (for the listing description)

> Stellar MD Editor asks for a single permission: access to the individual files you open
> with it. It cannot read your Drive, your email, or anything else. It has no servers:
> your text never leaves your browser except to save back to your own Google Drive.
