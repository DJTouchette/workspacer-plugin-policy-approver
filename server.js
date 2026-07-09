#!/usr/bin/env node
// Generic workspacer plugin sidecar scaffold — zero dependencies.
// Node >= 22 (global WebSocket) and >= 18 (global fetch). Reads its own
// plugin.json for the bus topics it subscribes to and the capabilities it may
// call, connects to the hub bus, logs events, and serves a tiny status pane.
// Implement your logic in onEvent(). See README for events + capabilities.
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9200);

// The hub injects the bus URL + this plugin's scoped token. Accept the common
// conventions so the scaffold runs however your hub wires it.
const BUS_URL = process.env.WKS_BUS_URL || 'ws://127.0.0.1:7895/bus';
function readToken() {
  if (process.env.WKS_BUS_TOKEN) return process.env.WKS_BUS_TOKEN;
  try { return fs.readFileSync(path.join(DIR, '.bus-token'), 'utf8').trim(); } catch { return ''; }
}
// Host-injected settings (from manifest `settings`), passed as JSON in env.
let settings = {};
try { settings = JSON.parse(process.env.WKS_SETTINGS || '{}'); } catch {}

const TOPICS = manifest.consumes || [];
const recent = [];
let ws = null, connected = false, callSeq = 0;
const pending = new Map();

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
  recent.unshift(new Date().toISOString() + '  ' + msg);
  if (recent.length > 100) recent.pop();
}

// Call a hub capability (must be declared in plugin.json `capabilities`).
function call(method, params) {
  return new Promise((resolve, reject) => {
    if (!connected) return reject(new Error('not connected'));
    const id = 'c' + (++callSeq);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ op: 'call', id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 8000);
  });
}
// Publish an event/command (must be declared in `emits`).
function publish(type, data) {
  if (connected) ws.send(JSON.stringify({ op: 'publish', event: { type, source: manifest.id, data: data || {} } }));
}

function connect() {
  const tok = readToken();
  ws = new WebSocket(BUS_URL + (tok ? '?token=' + encodeURIComponent(tok) : ''));
  ws.addEventListener('open', () => {
    connected = true;
    if (TOPICS.length) ws.send(JSON.stringify({ op: 'subscribe', topics: TOPICS }));
    log('connected; subscribed to ' + (TOPICS.join(', ') || '(nothing)'));
  });
  ws.addEventListener('message', (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.op === 'event' && f.event) onEvent(f.event).catch((e) => log('onEvent error: ' + e.message));
    else if (f.op === 'result' && pending.has(f.id)) { pending.get(f.id).resolve(f.result); pending.delete(f.id); }
    else if (f.op === 'error' && pending.has(f.id)) { pending.get(f.id).reject(new Error(f.error)); pending.delete(f.id); }
  });
  ws.addEventListener('close', () => { connected = false; setTimeout(connect, 1500); });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

// ── Policy engine ──────────────────────────────────────────────────────────────
// Supervise-by-exception: on an agent that blocks in `approval` mode, read the
// pending tool and decide by policy — auto-approve read-only tools, hard-hold
// mutating tools whose input matches a configured block pattern, and otherwise
// leave the decision for the human.

// Tools that never mutate the workspace — safe to auto-approve.
const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
// Tools that can mutate the workspace — subject to the block-pattern check.
const MUTATING_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit']);

// Settings (host-injected via WKS_SETTINGS), with the manifest defaults.
const autoApproveReadonly = settings.autoApproveReadonly !== false; // default true
const blockPatterns = String(
  settings.blockPatterns != null ? settings.blockPatterns : 'rm -rf,git push --force,:(){',
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Guard against acting twice on the same parked decision. pendingApproval has no
// tool_use id, so a decision is keyed by sessionId + toolName + its timestamp
// (each parked PreToolUse gets a distinct timestamp). Bounded to avoid growth.
const handled = new Set();
function markHandled(key) {
  handled.add(key);
  if (handled.size > 500) handled.delete(handled.values().next().value);
}

// Pull the searchable text out of a tool's input for block-pattern matching:
// the bash command, the target file path, and edited content — falling back to
// the whole serialized input so a pattern in any field is still caught.
function searchableInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') {
    try {
      return String(toolInput ?? '');
    } catch {
      return '';
    }
  }
  const parts = [];
  const push = (v) => {
    if (typeof v === 'string') parts.push(v);
  };
  push(toolInput.command); // Bash
  push(toolInput.file_path); // Write / Edit / MultiEdit
  push(toolInput.content); // Write
  push(toolInput.new_string); // Edit
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) if (e) push(e.new_string); // MultiEdit
  }
  try {
    parts.push(JSON.stringify(toolInput)); // catch-all fallback
  } catch {}
  return parts.join('\n');
}

function matchedPattern(text) {
  for (const p of blockPatterns) {
    if (p && text.includes(p)) return p;
  }
  return null;
}

async function onEvent(event) {
  const data = event && event.data ? event.data : {};
  // React only to agents that just entered a blocking approval prompt.
  if (event.type !== 'agent.state_changed' || data.mode !== 'approval') return;
  const sessionId = data.sessionId;
  if (!sessionId) return;

  let snap;
  try {
    snap = await call('sessions.snapshot', { sessionId });
  } catch (e) {
    log('snapshot failed for ' + sessionId + ': ' + e.message);
    return;
  }
  const pending = snap && snap.pendingApproval;
  if (!pending || !pending.toolName) return; // nothing parked (or already resolved)

  const toolName = pending.toolName;
  const key = sessionId + '|' + toolName + '|' + (pending.timestamp || '');
  if (handled.has(key)) return; // already decided this exact parked prompt
  markHandled(key);

  // 1) Auto-approve read-only tools.
  if (autoApproveReadonly && READONLY_TOOLS.has(toolName)) {
    try {
      await call('claude.approve', {
        sessionId,
        decision: 'yes',
        reason: 'policy-approver: read-only tool ' + toolName,
      });
      log('approved read-only ' + toolName + ' for ' + sessionId);
    } catch (e) {
      log('approve failed for ' + sessionId + ': ' + e.message);
    }
    return;
  }

  // 2) Hard-hold mutating tools whose input matches a block pattern.
  if (MUTATING_TOOLS.has(toolName)) {
    const hit = matchedPattern(searchableInput(pending.toolInput));
    if (hit) {
      try {
        // Enable the approval gate so the parked PreToolUse decision is held
        // rather than passed through — the human must clear it deliberately.
        await call('claude.gate', { sessionId, on: true });
      } catch (e) {
        log('gate failed for ' + sessionId + ': ' + e.message);
      }
      try {
        await call('notifications.post', {
          title: 'Policy Approver blocked ' + toolName,
          body:
            'Held ' +
            toolName +
            ' in ' +
            (data.cwd || snap.cwd || 'agent') +
            ' — matched blocked pattern "' +
            hit +
            '". Review before allowing.',
        });
      } catch (e) {
        log('notify failed for ' + sessionId + ': ' + e.message);
      }
      log('BLOCKED ' + toolName + ' for ' + sessionId + ' (pattern "' + hit + '")');
      return;
    }
  }

  // 3) Otherwise leave the decision for the human.
  log('deferred ' + toolName + ' for ' + sessionId + ' (no policy match)');
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=2>'
    + '<title>' + manifest.name + '</title><body style="font-family:system-ui;'
    + 'background:var(--wks-bg-base,#161616);color:var(--wks-text-primary,#e8e8e8);margin:0;padding:14px">'
    + '<h2 style="font-size:1rem">' + manifest.name + '</h2>'
    + '<p style="color:var(--wks-text-muted,#888);font-size:.8rem">'
    + (connected ? '\u{1F7E2} connected to hub' : '\u{1F534} disconnected')
    + ' · subscribed to ' + (TOPICS.join(', ') || '(nothing)') + '</p>'
    + '<pre style="font-size:.7rem;color:var(--wks-text-faint,#777);white-space:pre-wrap">'
    + (recent.map(escapeHtml).join('\n') || 'waiting for events…') + '</pre>'
    + '<p style="color:var(--wks-text-faint,#777);font-size:.7rem">Scaffold — edit '
    + '<code>server.js</code> (onEvent) to implement.</p>');
});
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));
connect();
