# M3: visual targeting and context

Select a rendered historical checkpoint, then choose **Select element**. This opens a separate installed Chromium window on that preview's loopback origin. Targeting is off by default. Its banner and highlight show when it is on; Escape or **Stop targeting** ends selection. Selecting another checkpoint closes the session. The ordinary **Open preview** browser is not injected.

Click a button or other element to select it. **Review packet** shows the text before **Copy packet** becomes available. Copy validates the selector again and refuses stale targets. **Check target** is a manual validation. Reloads preserve the host selection only when the selector is unique and its semantic fingerprint still matches. An indistinguishable replacement cannot be distinguished reliably; no fallback retargeting is attempted. Cross-origin navigations stop targeting, and nested frames are not injected.

## Packet and privacy

The packet names the checkpoint, best-effort selector, accessible-name approximation, short DOM snippet, route, changed paths and selected area. Changed paths come from checkpoint file hashes, not guessed DOM-to-source mapping. No agent reasoning or automatic Antigravity submission is claimed. Optional MCP was approved during M3 and is described below.

Root `.env` values are read in memory only. Explicit values of four or more characters, recognized credentials, emails and common absolute paths are removed from copy text. Route query/fragment data is omitted. This is a best-effort redaction pass, not a guarantee for unknown secret formats; inspect the review before pasting. Short values are excluded to avoid replacing ordinary letters everywhere.

The optional image is a **sanitized element crop**, not an exact screenshot. An inert clone retains selected typography, color and padding. Page scripts, attributes, fonts, pseudo-elements, backgrounds, media and form controls are omitted; text is redacted before capture. Original page DOM is not changed. This trades pixel fidelity for safer local evidence. If capture fails, text remains usable. Crops stay inside extension storage, are not copied to the clipboard, and are removed when the session closes.

## Automated evidence

Five targeting tests cover explicit secret/path/token redaction, accurate packet fields, selection/reload/duplicate/stale behavior, a real loopback targeting session and an edit producing a distinct disk checkpoint. Panel tests cover on/ready/stale/error states, review-before-copy, word budget and serious accessibility errors. UI test state lives only in tests; production contains no mock rows.

Local Linux: 38 unit/FS/crash/preview/targeting tests, 19 browser UI tests, VS Code 1.96.4 host activation/storage/edit/timeline/restore/Undo, typecheck, lint, format, build, no-placeholder gate and VSIX packaging. Windows CI is reported separately. Screenshots under `docs/evidence/m3_*` and `panel_m3_*` were inspected as pixels.

Human checks still needed: actual Antigravity interaction, Windows desktop Chromium targeting-window feel, accessible-name edge cases, and final M6 visual/motion polish. No OS preview sandbox or arbitrary secret detection is claimed.

## Approved optional MCP

Run **Scrubline: Start Local MCP** in a trusted local workspace. It opens JSON configuration for the installed standalone `dist/mcp.js` adapter. Add that configuration to Antigravity using its own current MCP setup UI. A local Node runtime is required. Scrubline does not edit client configuration automatically.

Exactly two tools are exposed: `list_checkpoints` returns ids, dates and redacted changed paths; `restore_checkpoint` requests the existing panel review and returns `pending_user_confirmation`. It never applies changes from MCP. The user must inspect the exact paths and confirm in the native Scrubline panel, which runs M2's safety, dirty/drift and journal checks. An external client receives no review token, apply action, source contents or connection credential. MCP annotations mark both calls read-only because neither writes workspace files; the restore description makes the deferred confirmation explicit.

Transport uses the official TypeScript MCP SDK over newline-framed stdio. The adapter talks to a random-port 127.0.0.1 bridge with a fresh per-session credential, exact Host check, denied browser Origins, 4KB request limit and 10-second timeout. The private connection file is outside the repository, mode 0600 on POSIX, and removed at shutdown. Windows protection inherits the user's private extension-storage ACL; this is not protection from another process running as the same OS user. Re-running Start Local MCP replaces the previous connection. No network-facing listener, unattended restore, prompts/resources or additional tools are included.

The SDK and stdio framing are tested with a real client; bridge tests cover denied token/origin/host/action/size, invalid ids and cleanup. The VS Code host test requests MCP restore, verifies unchanged disk bytes, then confirms through the existing review/apply path. Client compatibility in live Antigravity remains a Human check.

Protocol source: https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/
