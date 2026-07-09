# Policy Approver

Auto-approve safe tools, hard-block dangerous ones.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). **Runnable scaffold** — it loads, connects to the hub bus, and shows live activity; the real logic is stubbed with clear TODOs.

## What it does

On `agent.state_changed` → approval, reads the pending tool (`sessions.snapshot`) and decides by policy: auto-`claude.approve` read-only tools and edits inside the agent's cwd, hard-block `rm -rf` / `git push --force`. Turns the fleet from babysit-every-prompt into supervise-by-exception.

## Bus wiring

- **Subscribes to:** `agent.state_changed`
- **Calls capabilities:** `sessions.snapshot`, `claude.approve`, `claude.gate`, `notifications.post`
- **Emits:** —
- **Settings:**
- `autoApproveReadonly` (boolean) — Approve Read/Grep/Glob etc. without prompting.
- `blockPatterns` (string) — Bash substrings that are always blocked.

## Run it

1. Copy this folder to `~/.config/workspacer/plugins/policy-approver/` (or install from GitHub via the workspacer command palette → *Install from GitHub…* → `DJTouchette/workspacer-plugin-policy-approver`).
2. Reload plugins in workspacer.
   The hub supervises `node server.js` and injects the bus token.
3. Open the **Policy Approver** pane from the command palette.

## Implement

Edit `server.js` → `onEvent(event)`. Subscribed topics arrive there; use `call('method', params)` for capabilities and `publish('command.x', data)` for commands. `settings` holds the host-injected config above.

## Layout

```
policy-approver/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
