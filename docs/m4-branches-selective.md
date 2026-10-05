# M4: alternatives and narrow selective apply

Fork a selected checkpoint and name the alternative. Scrubline opens its isolated snapshot folder in a new editor window. Edit there, then **Capture** in the original panel. Capturing is explicit, not automatic. The original project and other alternative folders remain unchanged. Checkpoints retain parent pointers and branch identity; restart reconstructs fork heads from immutable manifests. The compact **Alternatives** list has fork markers, not a sprawling graph.

**Compare** renders current-workspace checkpoint and the chosen alternative independently, using configured preview command and adjacent ports (base + 1 and + 2), then shows screenshot views side by side. These are captured renders, not two live interactive iframes. Processes stop after capture. Historical commands can depend on excluded packages/data or fail; missing screenshots are labelled. Preview cwd isolation is not an OS sandbox.

## Choose files

**Choose files** opens an exact-path multi-select from the alternative's base-to-head changes. Three-way whole-file merge compares base, current and selected hash/mode. Current-only edits remain; same-result edits are accepted; both-edited, delete/edit and rename/edit overlap is rejected. Renames are deletion plus addition, not guessed identity. Hunk/AST merging and conflict resolution are not implemented. File-level application is the first supported source operation.

Review lists exactly the files that will change. Confirmation uses M2's drift/dirty checks, safety checkpoint, journal and Undo. Configure `scrubline.postApplyCommand` first. The trusted build/test command must pass on an isolated merged candidate without changing tracked sources before any writes. It runs again on the project after apply. A failure rolls back through Undo when bytes still match; if the command or another writer changed tracked bytes, they are preserved and recovery is surfaced. This is not an OS sandbox for commands, and a test command can have external side effects. Missing dependencies can block the isolated candidate; no silent bypass exists. Save/discard editor changes first, including changes made while the candidate command runs.

## First element prototype

**Navbar** accepts only a tracked standalone static HTML navbar document. One uniquely referenced stylesheet may accompany it. Embedded regions, footer/main, scripts, inline styles, handlers, unsupported tags/framework components, external styles, broad or shared CSS selectors and shared source references are blocked with one line. All three versions (base/current/selected) must pass ownership validation. This prototype selects owned files, not an arbitrary DOM subtree within a mixed document. It does not claim React mapping or general element cherry-pick.

The test fixture uses separate navbar and footer documents, which proves the supported navbar change can apply while an independently edited footer remains intact. A mixed navbar/footer file is explicitly unsupported. Shared CSS and framework cases are refusals, not best-effort edits.

## Evidence and gates

Nine branch tests cover independent alternatives, restart/lineage, navbar-only apply/footer preservation/Undo, both-edited/delete-edit/rename-edit conflict matrix, shared CSS/static ownership refusal, candidate and post-apply failures/rollback/late drift, and two real branch renders with unchanged original source. Host regression verifies fork capture and selective review alongside MCP/restore/Undo. UI verifies compact forks and narrow-width side-by-side comparison, accessiblity and copy budget.

Local gates: 47 unit/FS/crash/preview/targeting/MCP/branch tests, 20 UI tests, real VS Code host, typecheck/lint/format/build/no-placeholder and VSIX package (3.62MB). Windows CI is a separate publication gate. Evidence includes actual workspace/alternative PNGs and the narrow panel. Binary publication remains patch-only. Git worktrees are not used; all alternatives use isolated tracked snapshot copies without ignored/untracked files. Windows desktop feel, Antigravity integration and final M6 polish remain Human checks.
