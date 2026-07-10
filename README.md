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
close warning, word/char count with an approximate LLM-token estimate, markdown
wrap-on-selection (select text and press `*`, `_`, `` ` `` or `~`; press `*` twice for
bold), a markdown cheatsheet behind the "?" button in the statusbar, dark mode, read-only
detection, "New file" from Drive's New menu, shared-drive support. Sign-in is remembered
for about an hour (token cached in the browser), so opening several files in a row does
not re-prompt.

## Repository layout

```
public/           the whole app (static files, no build)
  index.html      landing / auth gate / editor views
  app.js          all logic (auth, Drive REST, editor) - set CLIENT_ID here
  style.css       light + dark theme
  privacy.html    privacy policy  (required for verification & listing)
  terms.html      terms of service (required for listing)
  support.html    support page with contact email (the listing's Support link)
Dockerfile        Caddy image serving public/ (how Railway runs it)
Caddyfile         listens on $PORT, gzip, basic security headers
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
(e.g. `http://localhost:3000`) to the authorized JavaScript origins of a Google OAuth
client you control, and put its ID in `CLIENT_ID` in `app.js`. To simulate Drive opening
a file, visit:

```
http://localhost:3000/?state={"ids":["<A_REAL_FILE_ID>"],"action":"open"}
```

(the file must be one this app created, or one you have opened with the app before;
the `drive.file` scope only grants access to such files).

## Hosting

The app is fully static. Production serves `public/` with Caddy (see `Dockerfile` and
`Caddyfile`) on Railway at `https://md.vedaispace.com/`; any static host would work the
same way. Pushes to the default branch auto-deploy.

## License

The source code is public for transparency, and Stellar MD Editor is free for users. It is licensed under the [PolyForm Shield License 1.0.0](LICENSE). Republishing or providing competing versions of the app is not permitted.