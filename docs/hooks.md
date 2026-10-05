# Antigravity hook recorder

Scrubline uses Antigravity lifecycle hooks for **attribution only**. Disk state is the authority; hooks never decide what gets captured.

## Configuration

`.agents/hooks.json` (workspace level) wires two events:

- `PostToolUse` (matcher `*`): `node ./.agents/scripts/hook-recorder.js post-tool`
- `Stop`: `node ./.agents/scripts/hook-recorder.js stop`

The `Stop` entry is a flat handler list on purpose: the current Antigravity hooks documentation specifies the simpler structure for `PreInvocation`, `PostInvocation`, and `Stop` (matcher ignored). Nesting `Stop` like `PostToolUse` would be wrong. Sources: https://antigravity.google/docs/hooks/ , https://antigravity.google/docs/ide/hooks/ .

The command path is workspace-relative (`./.agents/scripts/...`), matching the relative-path form shown in the official examples. Whether the hook runner's working directory is always the workspace root is **unverified until a live run**; that check is part of M0.1's human verification.

## What the recorder persists

One JSON line per event, allowlisted fields only:

- `timestamp`, `event`
- `conversation`: SHA-256 of the conversation ID, truncated to 12 hex chars
- `stepIdx` when present
- `tool`: tool name only (never tool arguments)
- `targetFile`: the tool target made workspace-relative; dropped entirely when outside every mounted workspace
- `terminationReason`, `fullyIdle` (Stop events)

Everything else in the payload - raw conversation IDs, absolute workspace paths, transcript and artifact paths, tool arguments, model names, free-form content - is discarded. Malformed payloads record only `payloadParseError: true`.

## Where it writes

`SCRUBLINE_HOOK_LOG` if set, otherwise `<os-tmpdir>/scrubline/hook-events.jsonl`. Never inside the repository. `*.jsonl` is gitignored as a second line of defence. M1 will route the log into extension storage once the extension owns a store.

## Output contract

- `post-tool`: `{}`
- `stop`: `{"decision":"allow"}` (any value other than `"continue"` lets the agent stop)

## Live verification (pending, human/agent in Antigravity)

1. Open this repo in Antigravity, run one agent edit, then stop the session.
2. Confirm one sanitised line per event in the log file (default location above).
3. Confirm the committed relative command path resolves; if the runner needs a different form, record the working form here before changing it.
