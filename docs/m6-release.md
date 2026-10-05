# M6 release gates

Version 0.6.0 is an unsigned VSIX. No marketplace publication or licence change was requested. Replay sharing is on hold by the owner; four preliminary M5 files remain inert, with no registered command, UI entry or export route in the shipped extension.

## Completed locally

- Theme-native typography, compact cards, Phosphor icons, focus/selected states, button feedback and 180ms entry motion. No unmatched historical-image morphing. Reduced-motion removes all CSS motion.
- 1000-checkpoint UI keeps one row mounted. Keyboard slider End reaches checkpoint 1000. Dark, light and high-contrast layouts at 300px pass serious/critical axe checks and overflow checks. Inspected actual rendered screenshots and start/mid/end motion frames.
- Store ancestry load uses map/set lookup rather than repeated graph scans. Linux measurement: 1000 persisted empty manifests restart about 200ms, about 0MB net heap delta, about 160ms CPU. This is not the owner's hardware benchmark. Capturing 1000 manifests takes about 28s on this environment because quota accounting scans stored files.
- Retention is conservative: every committed checkpoint remains until explicit deletion. Quota blocks new captures rather than evicting history. Compact unused history data deletes only orphan blobs and preserves every referenced snapshot. Delete workspace history asks for modal confirmation, stops capture/preview and removes only extension storage, never source files. Additional gitignore-style exclusions are configurable.
- 50 unit/FS/crash/render/release tests; 24 UI/axe/motion tests; real VS Code host activation/capture/MCP-review/restore/Undo/fork/selective tests. VSIX installed into a clean VS Code profile successfully; installed package host tests run separately.
- Clean default npm ci succeeds; Vitest 4.1.11 resolves the prior dev-only advisory. npm audit and runtime-only audit report zero vulnerabilities. No native module, Docker, runtime browser download or telemetry added.

## Human checks / documented limits

- Install on the owner's Windows Antigravity desktop and verify extension support, hook identity/payloads and rendered panel there. Existing automated host is VS Code, not proof of Antigravity support.
- Measure capture CPU/memory and animation feel on the actual integrated-graphics machine. Check screen reader and keyboard walkthrough in its real theme.
- Power-loss durability on Windows remains a host check; directory fsync is unsupported there.
- Uninstall does not automatically erase extension data. Use Delete workspace history first to erase it. Scrubline creates persistent capture files only in extension storage; fork folders are also there. The user's chosen hook log is not deleted.
- General element/hunk merge, prompt auto-submission, lossless agent-event replay and hosted sharing are not implemented. Navbar mapping remains narrow static HTML/CSS; historical commands are isolated by working directory, not an OS sandbox. Excluded dependencies/API/font randomness can prevent identical historical renders.
- Retention does not prune manifests automatically; this protects immutable IDs and branch ancestry. The quota is the hard storage bound. Old snapshots can be erased together by the explicit command. Optional second-framework mapping remains deferred.
