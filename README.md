# Policy Approver

Auto-approve safe tools, hard-block dangerous ones.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). Implemented and exercised end-to-end against a headless workspacer hub.

## What it does

Supervise-by-exception. When an agent blocks on a permission prompt (`agent.state_changed` with `mode === 'approval'`), it reads the pending tool with `sessions.snapshot` and applies a policy:

- **Auto-approve read-only tools** — `Read`, `Grep`, `Glob`, `LS`, `NotebookRead` are approved with `claude.approve` (`decision: 'yes'`) when `autoApproveReadonly` is on.
- **Hard-hold dangerous mutations** — for `Bash`, `Write`, `Edit`, `MultiEdit`, the pending input (bash command, target file path, edited content, plus the serialized input as a fallback) is scanned for any `blockPatterns` substring. On a match it calls `claude.gate` (`on: true`) to hold the parked decision and `notifications.post`s a warning naming the matched pattern.
- **Everything else is deferred** — left for the human to decide.

Each parked prompt is acted on at most once (keyed by session + tool + timestamp), so repeated `agent.state_changed` events don't double-fire. Turns the fleet from babysit-every-prompt into supervise-by-exception.

## Notifications

- **Hard-block** → a `notifications.post` with `level: "error"` titled *"Blocked \<tool\> for \<agent\>"*, the blocked command/file and the matched pattern in the body, and the agent's `sessionId` as the click target — clicking jumps straight to the blocked agent. Keyed per session, so repeated blocks on the same agent replace one notification slot instead of stacking.
- **Routine auto-approvals never toast.** With the `auditTrail` setting on (default **off**), each approval publishes a *silent* `notify.post` entry (history-only in the notification center, no toast, no OS notification) keyed per session with a running approval count.

## Bus wiring

- **Subscribes to:** `agent.state_changed`
- **Calls capabilities:** `sessions.snapshot`, `claude.approve`, `claude.gate`, `notifications.post`
- **Emits:** `notify.post` (silent audit-trail entries, only when `auditTrail` is on)
- **Settings:**
- `autoApproveReadonly` (boolean, default `true`) — Auto-approve read-only tools (`Read`/`Grep`/`Glob`/`LS`/`NotebookRead`) without prompting.
- `blockPatterns` (string, default `rm -rf,git push --force,:(){`) — Comma-separated substrings; a mutating tool whose input contains any of them is held for the human.
- `auditTrail` (boolean, default `false`) — Keep a silent per-session notification-center entry for routine auto-approvals (history only, never a toast).

## Run it

1. Copy this folder to `~/.config/workspacer/plugins/policy-approver/` (or install from GitHub via the workspacer command palette → *Install from GitHub…* → `DJTouchette/workspacer-plugin-policy-approver`).
2. Reload plugins in workspacer.
   The hub supervises `node server.js` and injects the bus token.
3. Open the **Policy Approver** pane from the command palette.

## Implement

The policy lives in `server.js` → `onEvent(event)`. It filters for `agent.state_changed` events with `mode === 'approval'`, calls `sessions.snapshot` to read the parked tool, then routes to `claude.approve`, `claude.gate` + `notifications.post`, or no-op per the rules above. `settings` holds the host-injected config (`autoApproveReadonly`, `blockPatterns`); block patterns are parsed by splitting on commas and trimming. Both snapshot provider shapes are supported: the desktop app's `pendingApproval` (`toolName`/`toolInput`) and the headless brain's claudemon passthrough (`pending: { kind: 'approval', tool, raw: { tool_name, tool_input } }`), so the policy works with or without the GUI running.

## Layout

```
policy-approver/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
