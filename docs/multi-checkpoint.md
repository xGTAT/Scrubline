# Multi-checkpoint composition

Introduced on the `feature/multi-checkpoint` branch (0.10.0).

## What changed

- Every checkpoint card in the panel has a **checkbox**. Checking cards adds
  them to a **selection tray** at the top of the timeline: the count, a mode
  selector, the ordered list of selected checkpoints as chips (reorder with
  the arrows, remove with x), **Clear**, and **Review**. Shift-click extends
  the range from the last toggled card. The selection survives panel reloads.
  The cap is `scrubline.multiSelectLimit` (default 20, maximum 50).
- **Review** composes the selected checkpoints into ONE synthetic candidate
  and runs it through the exact same review/apply/Undo pipeline as a single
  checkpoint: exact-path review, drift and dirty guards, safety snapshot,
  journaled transaction, post-apply verification, Undo. Checkpoints stay
  immutable; applying creates one new reconcile checkpoint whose attribution
  records `composed`, the mode, and the source checkpoint ids in order.

## Modes

- **Combine changes**: each selected checkpoint's *delta* (its diff against
  its own parent) is applied to the current workspace, in the order shown in
  the tray. This applies the changes only, never the whole historical
  workspace; single-checkpoint full restore is unchanged and stays a separate
  action. A file touched by several selected checkpoints folds in order;
  a true divergence (two selected checkpoints changed the same file from
  different bases) is a whole-file conflict, not a silent last-write-wins.
- **Revert changes**: the inverse of each delta, applied latest-first. If a
  file no longer matches the checkpoint's own result, a later change depends
  on it; the dependent checkpoint is named and the revert is a conflict
  rather than a partial unwind.
- **Pick per file (mosaic)**: per-file winner. The review lists every file
  touched by any selected checkpoint with a per-file dropdown of the
  checkpoints that touched it plus "current". Files without a choice keep
  current content. No merging, so composition itself never conflicts.

## Safety behavior

- Composition conflicts (combine divergence, revert dependencies) are listed
  in the review per file and **Confirm combined apply** stays disabled until
  the selection or overrides change. Applying through the same reviewed
  transaction means the existing guards still hold: unsaved buffers, drift
  between observed and actual workspace, concurrent edits after review, and
  crash recovery via the restore journal are all covered by the shared
  restore path and its tests.
- The combined candidate renders a **preview with a receipt** before
  confirmation. The label names the checkpoint count, mode and selection
  order; the receipt binds the exact rendered content. When the preview
  runner is unavailable or the render fails, the review still opens with the
  per-file table only and says so.
- **Dependency hints**: when an unselected checkpoint between the selected
  ones also touched a file in the composition, the review names it and
  offers one-click **Add** to extend the selection. Hints are advisory;
  conflicts are blocking.
- The baseline checkpoint has no parent diff; in combine mode every one of
  its files is treated as added and the review warns to prefer plain restore
  for it.

## MCP

- The local MCP server exposes a read-only `review_checkpoints` tool. It
  composes and opens the same review in the panel (paths redacted in the MCP
  response). Confirmation always happens in the panel; MCP can never apply
  files.

## Limits (honest list)

- Mosaic picks are **file-level**. Choosing individual elements per
  checkpoint inside one file is not implemented.
- Selection keyboard support is the native checkbox behavior (Space toggles
  the focused card). Shift+Arrow range selection is not implemented.
- Combine folds at **whole-file** granularity. Two checkpoints that edited
  different parts of the same file from different bases conflict instead of
  merging hunks.
- Side-by-side comparison of composed candidates and jump-to-source add-ons
  are not part of this change.
