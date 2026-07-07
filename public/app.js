'use strict';

/* ── Config ─────────────────────────────────────────────────────────── */

const CLIENT_ID = '203279034010-8d4n6ucitm5tf1fn5emfv5brsuag252l.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
}

function gate(message, btnLabel, onClick) {
  ui.gateMsg.textContent = message;
  ui.gateBtn.textContent = btnLabel;
  ui.gateBtn.onclick = onClick;
  show('gate');
  ui.gateBtn.focus();
}

let statusTimer;
function setStatus(msg, isError = false) {
  clearTimeout(statusTimer);
  ui.status.textContent = msg;
  ui.status.classList.toggle('error', isError);
  if (msg === 'Saved') {
    statusTimer = setTimeout(() => {
      if (ui.status.textContent === 'Saved') ui.status.textContent = '';
    }, 2500);
  }
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
  const tokens = Math.round(0.5 * (text.length / 4) + 0.5 * (words * 1.33));
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

function requestToken() {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error(resp.error)); return; }
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + (Number(resp.expires_in) - 60) * 1000;
      resolve();
    };
    tokenClient.error_callback = (err) => reject(new Error((err && err.type) || 'auth_failed'));
    tokenClient.requestAccessToken();
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
    accessToken = null; // token expired or revoked; re-auth once and retry
    return driveFetch(url, opts, true);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error.message; } catch (_) { /* non-JSON error body */ }
    throw new Error(detail || `Drive API error ${res.status}`);
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
    setStatus('Saved');
    return;
  }
  saving = true;
  ui.save.disabled = true;
  setStatus('Saving…');
  const contentAtSave = ui.editor.value;
  try {
    await driveFetch(`${UPLOAD}/files/${file.id}?uploadType=media&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'Content-Type': file.mimeType },
      body: contentAtSave,
    });
    // Keep the dirty flag if the user typed while the save was in flight.
    if (ui.editor.value === contentAtSave) setDirty(false);
    setStatus('Saved');
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

/* ── Events ─────────────────────────────────────────────────────────── */

ui.editor.addEventListener('input', () => {
  if (!dirty) setDirty(true);
  if (ui.status.textContent === 'Saved') setStatus('');
  updateCounts();
});

// Editor keys: Tab inserts two spaces; when text is selected, * _ ` ~ wrap the
// selection instead of replacing it (press * twice for **bold**). The selection
// is preserved so markers can be stacked. execCommand keeps the undo stack;
// setRangeText is the fallback.
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
    return;
  }
  const start = ui.editor.selectionStart;
  const end = ui.editor.selectionEnd;
  if (end > start && WRAP_KEYS.has(e.key)) {
    e.preventDefault();
    insertText(e.key + ui.editor.value.slice(start, end) + e.key);
    ui.editor.setSelectionRange(start + 1, end + 1);
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveFile();
  }
});

ui.save.addEventListener('click', saveFile);
ui.filename.addEventListener('change', renameFile);
ui.filename.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); ui.filename.blur(); }
});
ui.newFile.addEventListener('click', () => {
  if (demoMode) return;
  authThen(() => createFile(null));
});

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

  const state = parseState();
  loginHint = (state && state.userId) || undefined;
  await initAuth();

  if (!state || (state.action === 'open' && !(state.ids && state.ids.length))) {
    show('landing');
    return;
  }

  const run = state.action === 'create'
    ? () => createFile(state.folderId)
    : () => openFile(state.ids[0]);

  try {
    // Works when the browser allows the token popup on load; otherwise fall
    // back to an explicit user gesture so popup blockers don't strand us.
    await ensureToken();
  } catch (_) {
    gate('Stellar MD Editor needs your permission to access this file.', 'Continue with Google', () => authThen(run));
    return;
  }
  runSafely(run);
}

boot();
