'use strict';

/* ── Config ─────────────────────────────────────────────────────────── */

const CLIENT_ID = '203279034010-8d4n6ucitm5tf1fn5emfv5brsuag252l.apps.googleusercontent.com';
// Google Picker developer key: referrer-restricted, public by design, not a secret.
const PICKER_API_KEY = 'AIzaSyAjlpTcXji81kXVK7o_muylpDGRFm-Vxb8';
// GCP project number; the picker requires it for drive.file per-file grants.
const APP_ID = CLIENT_ID.split('-')[0];
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Save confirmation; support.html and the listing text quote it verbatim and
// must stay identical to it.
const SAVED_MSG = 'Saved to Drive';

// Sample document for ?demo=editor (UI preview and Marketplace screenshots).
const DEMO_TEXT = `# My article

Some markdown here...

## Why plain text wins

- Opens instantly, anywhere
- Diffs cleanly in version control
- Will still be readable in 30 years

Save with the button or Ctrl+S. Click the file name above to rename it.
`;

/* ── State ──────────────────────────────────────────────────────────── */

let file = null; // { id, name, mimeType, canEdit }
let dirty = false;
let saving = false;
let demoMode = false;
let accessToken = null;
let tokenExpiresAt = 0;
let tokenClient = null;
let loginHint;

const $ = (id) => document.getElementById(id);
const ui = {
  topbar: $('topbar'), statusbar: $('statusbar'),
  filename: $('filename'), dirty: $('dirty'), status: $('status'),
  readonly: $('readonly'), save: $('save'), editor: $('editor'),
  landing: $('landing'), gate: $('gate'),
  gateMsg: $('gate-msg'), gateBtn: $('gate-btn'),
  newFile: $('new-file'), counts: $('counts'),
  hints: $('hints'), hintsBtn: $('hints-btn'),
  install: $('install'), installMsg: $('install-msg'),
  openDrive: $('open-drive'), open: $('open'),
  confirmOpen: $('confirm-open'), confirmKeep: $('confirm-keep'), confirmDiscard: $('confirm-discard'),
};

const gisReady = new Promise((resolve) => {
  if (window.__gisReady) resolve();
  else window.__gisLoaded = resolve;
});

/* ── Views ──────────────────────────────────────────────────────────── */

function show(view) {
  ui.landing.hidden = view !== 'landing';
  ui.gate.hidden = view !== 'gate';
  ui.editor.hidden = view !== 'editor';
  ui.topbar.hidden = view !== 'editor';
  ui.statusbar.hidden = view !== 'editor';
  toggleHints(false);
}

const viewportMeta = document.querySelector('meta[name="viewport"]');

function toggleHints(force) {
  const open = force !== undefined ? force : ui.hints.hidden;
  ui.hints.hidden = !open;
  ui.hintsBtn.setAttribute('aria-expanded', String(open));
  // While the cheatsheet is open, let the soft keyboard overlay the page
  // (resizes-visual, the pre-2026-07-14 behavior) instead of squashing the
  // layout, where the popover would cover the entire shrunken editor. Only
  // Android Chrome honors interactive-widget; the flip applies from the next
  // keyboard open, which suffices because tapping "?" blurs the editor and
  // closes the keyboard first.
  viewportMeta.content = 'width=device-width, initial-scale=1, interactive-widget='
    + (open ? 'resizes-visual' : 'resizes-content');
}

function gate(message, btnLabel, onClick) {
  ui.gateMsg.textContent = message;
  ui.gateBtn.textContent = btnLabel;
  ui.gateBtn.onclick = onClick;
  show('gate');
  ui.gateBtn.focus();
}

function setStatus(msg, isError = false) {
  ui.status.textContent = msg;
  ui.status.classList.toggle('error', isError);
}

function setDirty(v) {
  dirty = v;
  ui.dirty.hidden = !v;
  syncTitle();
}

function syncTitle() {
  document.title = (dirty ? '● ' : '') + (file ? file.name : 'Stellar MD Editor');
}

function updateCounts() {
  const text = ui.editor.value;
  const words = (text.match(/\S+/g) || []).length;
  // Rough LLM-token estimate: average of a char-based and a word-based heuristic.
  // Rounded up: a partial token still costs a full token.
  const tokens = Math.ceil(0.5 * (text.length / 4) + 0.5 * (words / 0.75));
  ui.counts.textContent =
    `${words.toLocaleString()} words · ${text.length.toLocaleString()} chars · ~${tokens.toLocaleString()} tokens`;
}

/* ── Auth (Google Identity Services token flow) ─────────────────────── */

async function initAuth() {
  await gisReady;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    login_hint: loginHint,
    callback: () => {},
  });
}

// Tokens can't be refreshed silently in a pure browser app, and every file
// opens in a fresh tab, so without a cache each open costs a GIS popup.
// Caching the token for its ~1 h lifetime makes repeat opens silent. The hint
// check stops a token from one signed-in Google account from being reused
// when Drive launches the app for a different one.
const TOKEN_KEY = 'token';

function cacheToken(token, expiresIn) {
  accessToken = token;
  tokenExpiresAt = Date.now() + (Number(expiresIn) - 60) * 1000;
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ t: token, exp: tokenExpiresAt, hint: loginHint || '' }));
  } catch (_) { /* storage unavailable; the in-memory token still works */ }
}

function clearToken() {
  accessToken = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ }
}

function loadCachedToken() {
  try {
    const c = JSON.parse(localStorage.getItem(TOKEN_KEY));
    if (c && c.t && Date.now() < c.exp && (!loginHint || c.hint === loginHint)) {
      accessToken = c.t;
      tokenExpiresAt = c.exp;
    }
  } catch (_) { /* corrupt entry or storage unavailable */ }
}

function requestToken() {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error(resp.error)); return; }
      if (resp.state !== nonce) { reject(new Error('state_mismatch')); return; }
      cacheToken(resp.access_token, resp.expires_in);
      resolve();
    };
    tokenClient.error_callback = (err) => reject(new Error((err && err.type) || 'auth_failed'));
    tokenClient.requestAccessToken({ prompt: '', state: nonce });
  });
}

async function ensureToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return;
  await requestToken();
}

/* ── Drive REST ─────────────────────────────────────────────────────── */

async function driveFetch(url, opts = {}, retried = false) {
  await ensureToken();
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) },
  });
  if (res.status === 401 && !retried) {
    clearToken(); // token expired or revoked; re-auth once and retry
    return driveFetch(url, opts, true);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error.message; } catch (_) { /* non-JSON error body */ }
    throw new Error(detail || `Drive™ API error ${res.status}`);
  }
  return res;
}

// Files saved as e.g. application/octet-stream get normalized to plain text on save.
function normalizeMime(m) {
  return m && m.startsWith('text/') ? m : 'text/plain';
}

async function openFile(id) {
  setStatus('Loading…');
  const fields = encodeURIComponent('id,name,mimeType,size,capabilities(canEdit)');
  const meta = await (await driveFetch(`${API}/files/${id}?fields=${fields}&supportsAllDrives=true`)).json();
  if (Number(meta.size || 0) > MAX_FILE_BYTES) {
    throw new Error('This file is larger than 10 MB, too big for Stellar MD Editor.');
  }
  const text = await (await driveFetch(`${API}/files/${id}?alt=media&supportsAllDrives=true`)).text();

  file = {
    id: meta.id,
    name: meta.name,
    mimeType: normalizeMime(meta.mimeType),
    canEdit: !!(meta.capabilities && meta.capabilities.canEdit),
  };
  ui.editor.value = text;
  ui.editor.readOnly = !file.canEdit;
  ui.readonly.hidden = file.canEdit;
  ui.save.disabled = !file.canEdit;
  ui.filename.value = file.name;
  ui.filename.disabled = !file.canEdit;
  setDirty(false);
  setStatus('');
  updateCounts();
  show('editor');
  ui.editor.focus();
}

async function createFile(folderId) {
  setStatus('Creating…');
  const body = { name: 'Untitled.md', mimeType: 'text/markdown' };
  if (folderId) body.parents = [folderId];
  const meta = await (await driveFetch(`${API}/files?supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json();
  // Rewrite the URL to the normal open-state so a refresh reopens this file.
  const state = encodeURIComponent(JSON.stringify({ ids: [meta.id], action: 'open' }));
  history.replaceState(null, '', `?state=${state}`);
  await openFile(meta.id);
}

async function saveFile() {
  if (!file || !file.canEdit || saving) return;
  if (demoMode) {
    setDirty(false);
    setStatus(SAVED_MSG);
    return;
  }
  saving = true;
  ui.save.disabled = true;
  setStatus('Saving…');
  const contentAtSave = ui.editor.value;
  try {
    await driveFetch(`${UPLOAD}/files/${file.id}?uploadType=media&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'Content-Type': file.mimeType + '; charset=UTF-8' },
      body: contentAtSave,
    });
    // Keep the dirty flag if the user typed while the save was in flight.
    if (ui.editor.value === contentAtSave) setDirty(false);
    setStatus(SAVED_MSG);
  } catch (err) {
    setStatus('Save failed: ' + err.message, true);
  } finally {
    saving = false;
    ui.save.disabled = !file.canEdit;
  }
}

async function renameFile() {
  const newName = ui.filename.value.trim();
  if (!file || !newName || newName === file.name) {
    ui.filename.value = file ? file.name : '';
    return;
  }
  if (demoMode) {
    file.name = newName;
    syncTitle();
    return;
  }
  try {
    await driveFetch(`${API}/files/${file.id}?supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    file.name = newName;
    syncTitle();
  } catch (err) {
    ui.filename.value = file.name;
    setStatus('Rename failed: ' + err.message, true);
  }
}

/* ── Install (landing page) ─────────────────────────────────────────── */

// Registers the app in Drive's right-click "Open with" menu by requesting the
// drive.install grant. drive.file is bundled so opening a file afterward needs
// no second consent. This is the only place drive.install is requested; the
// editor runtime stays drive.file-only (SCOPE), so the minimal-permissions
// promise for editing is unchanged.
function showInstallMsg(msg, ok) {
  ui.installMsg.textContent = msg;
  ui.installMsg.classList.toggle('ok', ok === true);
  ui.installMsg.hidden = false;
}

async function install() {
  if (demoMode) return;
  await gisReady;
  ui.install.disabled = true;
  showInstallMsg('Waiting for Google…');
  const fail = () => {
    ui.install.disabled = false;
    showInstallMsg('That did not complete. Try again, or open a file from Drive™.');
  };
  const nonce = crypto.randomUUID();
  const installClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/drive.install ' + SCOPE,
    login_hint: loginHint,
    callback: (resp) => {
      if (resp.error || resp.state !== nonce) { fail(); return; }
      cacheToken(resp.access_token, resp.expires_in);
      ui.install.disabled = false;
      ui.install.textContent = 'Added to Google Drive™';
      showInstallMsg('Done. In Google Drive™, right-click a .txt or .md file, choose Open with, then Stellar MD Editor.', true);
    },
  });
  installClient.error_callback = fail;
  installClient.requestAccessToken({ state: nonce });
}

/* ── Open from Drive (picker) ───────────────────────────────────────── */

let pickerReady = null;

function loadPickerApi() {
  if (!pickerReady) {
    pickerReady = new Promise((resolve, reject) => {
      const fail = () => { pickerReady = null; reject(new Error('Could not load the file picker.')); };
      const s = document.createElement('script');
      s.src = 'https://apis.google.com/js/api.js';
      s.async = true;
      s.onload = () => gapi.load('picker', { callback: resolve, onerror: fail });
      s.onerror = fail;
      document.head.appendChild(s);
    });
  }
  return pickerReady;
}

async function openFromDrive() {
  try {
    await loadPickerApi();
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes('text/plain,text/markdown,text/x-markdown')
      .setMode(google.picker.DocsViewMode.LIST);
    new google.picker.PickerBuilder()
      .setAppId(APP_ID)
      .setDeveloperKey(PICKER_API_KEY)
      .setOAuthToken(accessToken)
      .addView(view)
      .enableFeature(google.picker.Feature.NAV_HIDDEN)
      .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
      .setCallback((data) => {
        if (data.action !== google.picker.Action.PICKED) return;
        const id = data.docs[0].id;
        const state = encodeURIComponent(JSON.stringify({ ids: [id], action: 'open' }));
        history.replaceState(null, '', `?state=${state}`);
        runSafely(() => openFile(id));
      })
      .build()
      .setVisible(true);
  } finally {
    // Safe to re-enable here: the picker is up (its modal backdrop blocks
    // re-clicks) or the load failed and the gate view took over. Both trigger
    // buttons are cleared; only one of them is visible in any view.
    ui.openDrive.disabled = false;
    ui.open.disabled = false;
  }
}

/* ── Events ─────────────────────────────────────────────────────────── */

ui.editor.addEventListener('input', () => {
  if (!dirty) setDirty(true);
  if (ui.status.textContent === SAVED_MSG) setStatus('');
  updateCounts();
});

// Editor keys: Tab (keydown) inserts two spaces; typing * _ ` ~ with text
// selected wraps the selection instead of replacing it (press * twice for
// **bold**). The selection is preserved so markers can be stacked. Wrapping
// hooks beforeinput, not keydown: soft keyboards report keydown as
// "Unidentified" (keyCode 229) and only expose the typed character in
// beforeinput's data, so a keydown version silently breaks on phones.
// execCommand keeps the undo stack; setRangeText is the fallback.
const WRAP_KEYS = new Set(['*', '_', '`', '~']);

function insertText(text) {
  if (!document.execCommand('insertText', false, text)) {
    ui.editor.setRangeText(text, ui.editor.selectionStart, ui.editor.selectionEnd, 'end');
    ui.editor.dispatchEvent(new Event('input'));
  }
}

ui.editor.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey || ui.editor.readOnly) return;
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    insertText('  ');
  }
});

ui.editor.addEventListener('beforeinput', (e) => {
  // insertText() below re-triggers this handler with the whole wrapped string
  // as data; it is never a single wrap character, so there is no recursion.
  if (e.inputType !== 'insertText' || !WRAP_KEYS.has(e.data)) return;
  const start = ui.editor.selectionStart;
  const end = ui.editor.selectionEnd;
  if (end <= start) return;
  e.preventDefault();
  insertText(e.data + ui.editor.value.slice(start, end) + e.data);
  ui.editor.setSelectionRange(start + 1, end + 1);
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveFile();
  } else if (e.key === 'Escape' && !ui.hints.hidden) {
    toggleHints(false);
  }
});

ui.hintsBtn.addEventListener('click', () => toggleHints());

ui.save.addEventListener('click', saveFile);
ui.filename.addEventListener('change', renameFile);
ui.filename.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); ui.filename.blur(); }
});
ui.newFile.addEventListener('click', () => {
  if (demoMode) return;
  authThen(() => createFile(null));
});
ui.openDrive.addEventListener('click', () => {
  if (demoMode) return;
  // Disabled from click until the picker shows: a double-tap would otherwise
  // stack two pickers, or clobber the pending token request's callback.
  ui.openDrive.disabled = true;
  authThen(openFromDrive);
});
function startOpenFromDrive() {
  ui.open.disabled = true; // same double-tap guard as the landing button
  authThen(openFromDrive);
}

ui.open.addEventListener('click', () => {
  if (demoMode) return;
  // Opening another file replaces the editor content in place, so beforeunload
  // never fires; this prompt is the only unsaved-changes safety net here. An
  // in-app <dialog> instead of confirm(): browsers title confirm() with the
  // page origin ("md.vedaispace.com says"), which pages cannot change.
  if (dirty) {
    if (ui.confirmOpen.showModal) { ui.confirmOpen.showModal(); return; }
    if (!confirm('You have unsaved changes that will be lost. Open another file?')) return;
  }
  startOpenFromDrive();
});
ui.confirmKeep.addEventListener('click', () => ui.confirmOpen.close());
ui.confirmDiscard.addEventListener('click', () => {
  ui.confirmOpen.close();
  startOpenFromDrive(); // this click is itself the user gesture GIS may need
});
ui.install.addEventListener('click', install);

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ── Boot ───────────────────────────────────────────────────────────── */

function parseState() {
  try {
    const raw = new URLSearchParams(location.search).get('state');
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function authThen(run) {
  ensureToken()
    .then(() => runSafely(run))
    .catch((err) => {
      const why = String(err.message) === 'access_denied'
        ? 'You declined access. The app only sees files you open with it.'
        : 'Google sign-in didn’t complete.';
      gate(why, 'Try again', () => authThen(run));
    });
}

async function runSafely(run) {
  try {
    await run();
  } catch (err) {
    gate(err.message || 'Something went wrong.', 'Retry', () => runSafely(run));
  }
}

function startDemo(view) {
  demoMode = true;
  if (view !== 'editor') {
    show('landing');
    return;
  }
  file = { id: 'demo', name: 'article.md', mimeType: 'text/markdown', canEdit: true };
  ui.editor.value = DEMO_TEXT;
  ui.filename.value = file.name;
  setDirty(false);
  updateCounts();
  show('editor');
  ui.editor.focus();
}

async function boot() {
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo !== null) {
    startDemo(demo);
    return;
  }
  if (CLIENT_ID.startsWith('REPLACE')) {
    gate('Setup required: set CLIENT_ID in app.js (see README.md).', 'Reload', () => location.reload());
    return;
  }
  // Demo mode returns before this, so the buttons stay visible for screenshots;
  // a deploy without the key hides them cleanly.
  ui.openDrive.hidden = PICKER_API_KEY.startsWith('REPLACE');
  ui.open.hidden = ui.openDrive.hidden;

  const state = parseState();
  loginHint = (state && state.userId) || undefined;
  loadCachedToken();
  await initAuth();

  if (!state || (state.action === 'open' && !(state.ids && state.ids.length))) {
    show('landing');
    return;
  }

  const run = state.action === 'create'
    ? () => createFile(state.folderId)
    : () => openFile(state.ids[0]);

  // Cold start with no usable cached token: go straight to the gate. Never
  // try the token popup without a user gesture; browsers block it and show
  // a "Pop-ups blocked" warning that looks broken (owner call 2026-07-22).
  if (accessToken && Date.now() < tokenExpiresAt) {
    runSafely(run);
  } else {
    gate('Stellar MD Editor needs your permission to access this file.', 'Continue with Google', () => authThen(run));
  }
}

boot();
