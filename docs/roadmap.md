# Scrubline — Implementation Roadmap

*Prepared Oct 16, 2026 — response to jury feedback, for the project creator*

This turns the Oct 16 jury feedback into four build phases, ordered by what's genuinely hard versus what's already close to done. The two items the jury flagged under "High" as hardest — multi-element cherry-pick and framework support beyond HTML — are the same two problems your own `PLAN.md` already predicted would need dedicated research spikes back in September. Nothing here contradicts your existing milestone discipline; it sequences new work around it and reuses code you've already shipped (M1 capture, M3 selectors, M4 ownership validation) wherever possible instead of rebuilding.

## Priority summary

| Item | Verdict | Effort | Phase |
| --- | --- | --- | --- |
| Element locking | Easy — reuses M3 selectors | 2–4 days | 1 |
| Fix Show/Hide Changes scroll bug | Trivial, isolated CSS fix | <1 day | 1 |
| Output verification (comparison method) | Mostly already built (0.7.10–0.8.2) — needs naming/wiring | 3–5 days | 1 |
| Multi-page scrubline | Medium — plumbing, not research | 1–2 weeks | 2 |
| UI simplification | Medium, concrete list below | \~1 week | 2 |
| Multi-element cherry-pick | Hard — stage it, don't solve it whole | 2–3 weeks (Stage A+B) | 3 |
| In-panel chatbot (via MCP) | Medium, reuses existing MCP server | 3–5 days | 4 |
| Beyond vanilla HTML (framework ownership) | Hard — genuine R&D spike | 3+ weeks | 4 |
| Market feasibility / positioning | Decision, not engineering | — | Ongoing |
| Backend visuals | Low priority, correctly deferred | — | Defer |

## High priority

### 1. Element locking

**Problem:** lock a specific element so neither a manual edit nor an agent edit touches it again without the user knowing.

**Why this is the easy half:** it does not require solving ownership-mapping in general — it only needs to flag when a known byte range changed. M3 already produces a unique selector + semantic fingerprint per targeted element, and M1 already runs a bounded hash-reconciliation pass on every checkpoint. Locking is mostly new wiring between two things you've already built.

**Ship in two layers, Layer 1 first:**

1. **Layer 1 — soft lock (detect and flag).** Add a `Lock` record per selector: `{selectorId, filePath, sourceRange, fingerprint, lockedAt}`, stored the same way as checkpoint manifests (JSON, outside the repo). On every checkpoint's existing hash-reconciliation pass, diff each locked file's recorded range between the prior and new checkpoint. If it changed, surface a "Locked element changed" badge on that checkpoint card — same visual slot the "Unattributed" badge uses today. Do not auto-revert; keep the user-in-the-loop review pattern M2 already established.
2. **Layer 2 — hard lock (pre-emptive, pairs with hooks).** If an Antigravity `PreToolUse` hook payload names a target file (per `docs/hooks.md`), check it against active locks before the tool runs and surface a warning in the hook response. This only works when hooks are configured — same honesty discipline as the rest of the project: label it "detected after the fact" unless hook coverage is actually confirmed for that edit path.

**Implementation steps:**

1. Add lock storage alongside existing checkpoint manifests.
2. Add a lock-icon toggle to the already-built "Select element" targeting panel (M3) — reuse its selector and fingerprint, don't rebuild targeting.
3. Hook the lock check into the existing debounce/hash-reconciliation pass (M1).
4. Add the badge + affected-lock list to the checkpoint card, matching the "Unattributed" visual language.
5. Tests: lock survives restart (read from manifest); a lock on a removed/stale element is retired with a message, same pattern M3 already uses for stale selectors.

**Effort:** 2–4 days, reusing most of the M1 and M3 code paths directly.

**Precedent:** Framer shipped layer locking in its on-page AI editing for exactly this reason, and there's active demand for it independent of any specific tool (see Sources).

### 2. Multi-element cherry-pick

**Problem:** select more than one element and merge each from a different checkpoint or branch into the current state.

**Why this is hard:** M4's only working case today is a single, fully standalone HTML+CSS navbar document with no shared selectors. General ownership-mapping for arbitrary elements inside a mixed document (a React component, a shared stylesheet, JS behavior) is unsolved industry-wide — even Figma, a pure design tool with no code underneath, has a long-standing unanswered community request for "merge only select elements" (see Sources). Do not attempt general cherry-pick directly.

**Recommended staged approach — generalize the narrow case you already have, don't invent a new one:**

- **Stage A — widen M4's ownership model.** Today it hardcodes navbar/footer detection. Refactor the *same* validation checks already written (no shared selectors, no embedded framework syntax, no inline handlers, one uniquely-referenced stylesheet) to accept *any* tracked file or CSS-only block that passes them — not just a navbar. This alone unlocks any standalone static section (hero, footer, sidebar, CTA block) with no new research, just a refactor.
- **Stage B — multi-select UI, reuse what exists.** M4 already has exact-path multi-select for file-level apply ("Choose files"). Extend that same list/checkbox UI to element-scoped targets captured via M3's selector/fingerprint, each resolving to its owning file(s) under Stage A's rules. Each selected element still goes through the *same* three-way merge and ownership refusal M4 already runs — multi-select here just means batching N validated single applies through the same post-apply build/test gate, not a new merge algorithm.
- **Stage C — real component ownership (optional, only after A+B prove the UX is wanted).** True ownership for one framework (see "Beyond vanilla HTML" below) via React DevTools' component-tree protocol or source maps. Treat it as its own milestone with a falsifiable "done when," matching your existing M-series discipline. Do not ship until a prototype passes that test on a real fixture app.

**Effort:** Stage A+B ≈ 2–3 weeks (mostly refactor + UI reuse); Stage C is 3+ weeks of genuine research — sequence it after A/B prove the feature is worth having.

### 3. Multi-page scrubline

**Problem:** scrub and preview across more than one route or page of a multi-page app, not just one.

**Why this is medium, not hard:** capture (M1) is already file-based and route-agnostic — a checkpoint already contains every tracked file regardless of which route serves it. The only real gap is the preview/render layer, which today takes one `previewRoute` string.

**Concrete steps:**

1. Replace the single `scrubline.previewRoute` setting with an array `scrubline.previewRoutes`, keeping the old single-string setting valid as a one-item array for backward compatibility.
2. Extend the existing sequential render loop (M2/0.7.0's "Render history" with its progress/cancel and persistent PNG cache) to render N routes per checkpoint instead of 1 — same cache-key pattern, just keyed by `(checkpoint, route)` instead of `(checkpoint)` alone.
3. Add a route selector or tab strip next to the existing checkpoint slider. Switching route re-renders the same checkpoint's cached screenshot for that route — no new scrub mechanism needed.
4. Keep it explicit and bounded: the user adds routes manually, this is not a site crawler — consistent with Render history already being a manual action, not automatic, today.
5. Surface the added render cost: the panel already shows "Render history (0/1)" as a fraction; extend the denominator to `checkpoints × routes` so users see the real cost before triggering a render pass.

**Effort:** 1–2 weeks, almost entirely plumbing through existing render/cache code — no new research required.

### 4. Beyond vanilla HTML

Split this into two separate claims — they have very different difficulty:

**A) Preview/scrub already works today for React, Vue, Svelte, etc.** No changes needed. `previewCommand` just runs whatever dev-server command the user configures, and Scrubline screenshots whatever renders. State this explicitly in the README and to the jury — the current limitation is specifically in cherry-pick/selective-apply, not in watching or scrubbing a framework app.

**B) Cherry-pick/selective-apply for framework components is genuinely hard.** Your own `PLAN.md` already flagged this as deferred: "pick one framework after an instrumented prototype; general React/HTML/CSS cherry-pick is not a v1 claim." Concrete next step:

1. **Pick React first.** It's the largest share of AI-generated web output and matches your competitive set — v0, Bolt and Lovable are mostly React.
2. **Spike:** use React DevTools' backend protocol (the same mechanism the official React DevTools extension uses to read the fiber tree) to map a clicked DOM element back to its owning component name, file and line, when source maps are present — true in almost all dev builds.
3. **Validate on a purpose-built fixture first**, the same way `fixtures/sample-web` works today for the HTML case — not a real user project, so the result stays falsifiable like the rest of your M-series milestones.
4. **"Done when" (matching your own discipline):** clicking a rendered element in the M3 targeting overlay returns the exact component file + line with ≥95% accuracy on the fixture app, and a stale or ambiguous case is refused outright rather than guessed — the same refusal discipline your CSS-ownership checks already use.
5. Only once that prototype passes its own "done when" should Stage C of multi-element cherry-pick (above) consume it.

**Effort:** 3+ weeks of real research. Treat it as its own milestone, not a sprint task.

### 5. Output verification (comparison method)

**This is already substantially built — formalize it, don't reinvent it.** The changelog shows real progress already: 0.7.10 added persistent region outlines comparing rendered checkpoints; 0.8.0 requires "two fresh render probes" before trusting a render as reproducible (classified as repeatable-in-two-probes vs. unstable, never assumed); 0.8.1–0.8.2 added CSS-culprit investigation with geometry assertions and bounded probe budgets.

**What "not screenshots?" is really asking for:** raw pixel diff is noisy — anti-aliasing, sub-pixel font rendering and timing all cause false positives. A pure pixel-diff verifier would flag changes constantly. Your existing two-probe-reproducibility check *is* the right fix for that; it just isn't packaged as a named, visible feature yet.

**Recommended feature: "Verify restore."** Before applying Review restore to a targeted element:

1. Capture two fresh render probes of the current state (reuse the existing 0.8.0 mechanism) to confirm a stable baseline.
2. Apply the restore to an isolated candidate, using the same isolation pattern M4 already uses for merge candidates.
3. Capture two fresh render probes of the candidate state.
4. Compare *only* the targeted element's region: a computed-style delta (position, size, color, font — read via DOM, not pixels) as the primary structural check, with a pixel-region diff scoped tightly to the element's bounding box as a secondary cross-check only.
5. Report an explicit, bounded claim: "Changed: \[targeted element\]. Unchanged: \[N other elements checked\]" — never "nothing else changed anywhere," matching the project's refuse-over-guess discipline.
6. Surface pass/fail/unknown, reusing the exact three-state pattern 0.8.1 already established, linked into the existing Review restore flow.

**Effort:** 3–5 days — mostly wiring together primitives from 0.7.10, 0.8.0 and 0.8.2 under one named, visible feature instead of leaving the capability implicit in CSS-debug tooling.

## Medium priority

### UI simplification

Concrete items, based on the current panel:

- **Collapse the button wall.** Combine Prev / Next / Play into one segmented control instead of three full-width stacked buttons.
- **Move secondary actions into an overflow menu.** Fullscreen, Retry preview, Compact history and Delete history belong behind a "⋯" menu — keep only Review restore and Fork checkpoint as primary, full-width actions, since those are the two moments that actually matter.
- **Soften "Unattributed."** A first-time user reads this as an error, not neutral information (observed directly during setup this week). Replace with "Not linked to an agent action" plus an info icon pointing at hook setup.
- **Turn red error banners into onboarding.** "Preview unavailable — set a preview command in Settings" should be a one-time inline setup prompt the first time a workspace opens, not a persistent error state the user has to decode.
- **Fix the Show/Hide Changes stacking-context bug while touching this area** — see Bug fix below; likely the same class of layering issue worth auditing across the whole panel.
- **Keep internal jargon out of user-facing copy.** "Manifest," "drift," "three-way merge" are fine in `docs/`, wrong in panel labels — prefer "someone else changed this file" or "can't combine automatically."

### Market feasibility

**Current landscape (checked October 2026):** Replit Agent has checkpoints/rollback; VS Code ships native chat checkpoints with restore and fork; v0, Lovable, Bolt and Figma Make differentiate on generation quality and hosting, not review granularity. None of them do element-level, lockable, mergeable review today.

**The gap is validated from two independent directions**, not just this project's own reasoning: Figma's community has a long-standing, unanswered request for "merge only select elements" — even a pure design tool with no code underneath hasn't solved this. Separately, a Vercel community thread titled "How do you prevent AI from Making unauthorized changes?" shows real developer pain around exactly this problem, independent of any specific tool (see Sources).

**Recommended positioning:** don't compete as another app builder — that fight goes to funded, generation-quality-focused incumbents. Position Scrubline as the **review and trust layer that sits on top of whichever agent or IDE someone already uses.** The local MCP server already embodies this correctly: read-only tools, never competes with or replaces the host agent.

**Target user:** people who have already been burned by an agent breaking something that worked — agencies, hackathon or student builders, indie hackers. "Anyone using AI" is too broad to sell to.

**Sequencing:** lead with Phase 1 (locking, the bug fix, a named verification feature) as the demo story — "lock what works, trust what changed" — before chasing framework breadth. Trust sells to the people already using Scrubline today; breadth alone sells to fewer people than that.

## Low priority

### In-panel chatbot

**Don't bundle a local LLM.** It breaks the project's own stated minimalism — "no native modules," "no runtime browser download" — and a usable quantized model still adds 1–4GB plus a new native-dependency surface for marginal gain.

**Expand what you already built instead.** The local MCP server today exposes exactly two read-only tools: `list_checkpoints` and `restore_checkpoint` (request-only, never applies). Add:

- `get_checkpoint_diff(checkpointId)` — changed paths plus per-file diff, read-only.
- `find_checkpoints_touching_selector(selectorId)` — built on the M3 selector/fingerprint data already captured.
- `get_lock_status(selectorId)` — once element locking (above) ships.

Let the user's own agent — whichever is already open, Antigravity, Claude, Cursor — call these tools directly. No new chat UI, no new model, no new API key management. This matches the existing MCP boundary exactly: "never applies changes from MCP," "no agent reasoning fabricated."

If an in-panel chat box is still wanted later, the cheapest *correct* version calls out to whatever LLM API the user's host IDE already has configured — never a locally bundled model.

**Effort:** 3–5 days to add two or three read-only MCP tools, reusing data structures that already exist.

### Backend visuals

Agree with the jury's own prioritization — defer this. If "backend visuals" means visualizing changes to a backend service's state rather than a webpage, that is a meaningfully different and harder problem (no DOM/CSSOM to diff against), worth only a one-line spike after Phases 1–3 ship, never before.

## Bug fix

**Diagnosis:** a classic stacking-context issue. The Show/Hide Changes button is likely `position: sticky` (or `fixed`) without a `z-index` set above the Prev/Next/Play control row's own stacking context — or the scrollable list container creates a new stacking context that traps the button below siblings rendered later in DOM order.

**Fix steps:**

1. Inspect the computed `position` and `z-index` of both the button and the Prev/Next/Play row in devtools while the glitch is reproduced.
2. If the button is `sticky` inside a scrolling list, give it an explicit `z-index` higher than the control row's, and confirm its nearest *positioned* ancestor is the scroll container itself — sticky positioning is relative to the nearest scrolling ancestor, not the viewport.
3. If the control row lacks its own stacking context, give it one (`position: relative` + `z-index`) so sticky elements layer predictably against it.
4. Regression-test by scrolling a 20+ checkpoint history and confirming the button never visually overlaps the control row, in light, dark and high-contrast themes — reuse the existing M6 visual QA pattern.

**Effort:** under a day.

## Note on backboard.io

Checked directly: backboard.io is "sovereign AI infrastructure" — model routing across 17,000+ models, memory/RAG, and on-prem or air-gapped deployment, aimed at regulated enterprises. It is **not** a general backend-as-a-service — it won't give Scrubline (or apps built with it) a database, auth, or hosting.

Confirm what problem this was meant to solve before spending time integrating it. Two likely intents: a naming mix-up with a Supabase/Firebase-style tool (wrong fit), or interest in routing the in-panel chatbot's model calls (item above) — in which case it's relevant, just not as "backend" infrastructure.

## Recommended build sequence

&#91;embedded content: build sequence · 4 phases, 3 gates\]

Phase gates are checkpoints, not hard blockers — if Phase 3 research stalls, Phase 4's MCP-tool work can still proceed independently.

## Sources

- [Framer on-page editing 2.0 (layer locking)](https://www.framer.com/updates/on-page-editing-2.0)
- [Vercel community: preventing unauthorized AI changes](https://community.vercel.com/t/how-do-you-prevent-ai-from-making-unauthorized-changes/31914)
- [Figma forum: merge only select elements](https://forum.figma.com/t/merge-only-select-elements/4796/16)
- [Replit: checkpoints and rollbacks](https://docs.replit.com/core-concepts/agent/checkpoints-and-rollbacks)
- [VS Code chat checkpoints](https://code.visualstudio.com/docs/chat/chat-checkpoints)
- [AI prototyping tool comparison, 2026](https://echai.ventures/how-founders-use-ai/design-prototyping/which-ai-prototyping-tool-should-i-pick-v0-lovable-bolt-replit-or-figma-make)
- [backboard.io](https://backboard.io)
- Internal: `PLAN.md`, `CHANGELOG.md`, `docs/m3-targeting-context.md`, `docs/m4-branches-selective.md` (xGTAT/scrubline repository, as of 2026-10-16)
