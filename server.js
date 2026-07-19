#!/usr/bin/env node
// Generic workspacer plugin sidecar scaffold — zero dependencies.
// Node >= 22 (global WebSocket) and >= 18 (global fetch). Reads its own
// plugin.json for the bus topics it subscribes to and the capabilities it may
// call, connects to the hub bus, logs events, and serves a tiny status pane.
// Implement your logic in onEvent(). See README for events + capabilities.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { connect } = require('./wks.js');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9200);

// Connect to the hub bus via the vendored plugin SDK (wks.js). It reads the
// scoped token (HUB_TOKEN / WKS_BUS_TOKEN / .bus-token), subscribes, delivers
// events, and reconnects if the hub goes away. Settings come from the SDK too.
const wks = connect({ source: manifest.id });
const settings = wks.settings;

const TOPICS = manifest.consumes || [];
const recent = [];

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
  recent.unshift(new Date().toISOString() + '  ' + msg);
  if (recent.length > 100) recent.pop();
}

// Route each consumed topic to onEvent (the SDK subscribes to '*' internally).
for (const t of TOPICS) wks.on(t, (data, event) => onEvent(event).catch((e) => log('onEvent error: ' + e.message)));
// Log once per (re)connect, mirroring the old open handler.
wks.onStatus((c) => { if (c) log('connected; subscribed to ' + (TOPICS.join(', ') || '(nothing)')); });

// ── Policy engine ──────────────────────────────────────────────────────────────
// Supervise-by-exception: on an agent that blocks in `approval` mode, read the
// pending tool and decide by policy — auto-approve read-only tools, hard-hold
// mutating tools whose input matches a configured block pattern, and otherwise
// leave the decision for the human.

// Tools that never mutate the workspace — safe to auto-approve.
const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
// Tools that can mutate the workspace — subject to the block-pattern check.
const MUTATING_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit']);

// Settings (from the plugin SDK / manifest defaults).
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

// Accept both snapshot providers' shapes for the parked approval:
// - desktop app:      { pendingApproval: { toolName, toolInput, timestamp } }
// - headless brain:   { pending: { kind:'approval', tool, summary,
//                        raw: { tool_name, tool_input, … } } }  (claudemon)
function pendingApprovalOf(snap) {
  if (!snap || typeof snap !== 'object') return null;
  const pa = snap.pendingApproval;
  if (pa && pa.toolName) return pa;
  const p = snap.pending;
  if (p && String(p.kind || '').toLowerCase() === 'approval') {
    const raw = p.raw && typeof p.raw === 'object' ? p.raw : {};
    const toolName = p.tool || raw.tool_name;
    if (!toolName) return null;
    return { toolName, toolInput: raw.tool_input, timestamp: raw.timestamp || 0 };
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
    snap = await wks.call('sessions.snapshot', { sessionId });
  } catch (e) {
    log('snapshot failed for ' + sessionId + ': ' + e.message);
    return;
  }
  const parked = pendingApprovalOf(snap);
  if (!parked || !parked.toolName) return; // nothing parked (or already resolved)

  const toolName = parked.toolName;
  const key = sessionId + '|' + toolName + '|' + (parked.timestamp || '');
  if (handled.has(key)) return; // already decided this exact parked prompt
  markHandled(key);

  // 1) Auto-approve read-only tools.
  if (autoApproveReadonly && READONLY_TOOLS.has(toolName)) {
    try {
      await wks.call('claude.approve', {
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
    const hit = matchedPattern(searchableInput(parked.toolInput));
    if (hit) {
      try {
        // Enable the approval gate so the parked PreToolUse decision is held
        // rather than passed through — the human must clear it deliberately.
        await wks.call('claude.gate', { sessionId, on: true });
      } catch (e) {
        log('gate failed for ' + sessionId + ': ' + e.message);
      }
      try {
        await wks.call('notifications.post', {
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
    + (wks.connected ? '\u{1F7E2} connected to hub' : '\u{1F534} disconnected')
    + ' · subscribed to ' + (TOPICS.join(', ') || '(nothing)') + '</p>'
    + '<pre style="font-size:.7rem;color:var(--wks-text-faint,#777);white-space:pre-wrap">'
    + (recent.map(escapeHtml).join('\n') || 'waiting for events…') + '</pre>'
);
});
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));
