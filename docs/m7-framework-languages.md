# M7: framework language support

Element pick and selective apply beyond static HTML. Static analysis only:
source files are parsed and indexed with exact byte ranges; no build, no
bundler plugin, no node_modules. Works on any checkpoint, including
historical snapshots that cannot run a dev server.

## Supported

- JSX/TSX sources: React, Preact, Solid, Next.js and other JSX stacks
  (`@babel/parser`, plugins `jsx` + `typescript`).
- Single-file components: `.vue`, `.svelte`, `.astro`. Templates are parsed
  as HTML after masking `{...}` expressions with same-length placeholders, so
  byte offsets stay exact. `<style>` blocks (including `scoped`) pair with
  the same ownership rules as standalone stylesheets.
- Angular component templates go through the existing static HTML path;
  `*ngFor`, `[binding]` and `(click)` attributes are accepted there.
- Stylesheets: `.css` (postcss), `.scss` (postcss-scss), `.less`
  (postcss-less). SCSS/Less nesting is never treated as owned.
- Tailwind utility classes and JSX inline `style={{...}}` objects travel with
  the element subtree automatically.

## Matching and safety

- A picked element carries tag, id, data-testid, accessible name, text and
  href. id/data-testid resolve only when unique; otherwise a scored match on
  tag + aggregated subtree text + name must beat the runner-up by a clear
  margin. Ambiguity (for example repeated cards rendered from the same
  `.map()` without anchors) refuses with a plain-language reason.
- The matched element must map into the current version of the same file by
  unique id or unique tag+text+ancestor identity. Structural drift refuses.
- Selector ownership supports comma lists, descendant/child combinators, tag,
  `.class` and `#id` only; anything else is never rolled back. A rule is
  owned only when every matching source element sits inside the selected
  subtree in both versions.
- CSS-in-JS (styled-components/emotion) is detected: markup and inline
  styles restore, component-defined styles stay current, and the review says
  so.

## Not claimed

- Runtime source mapping (compile-time data-attribute injection).
- Previewing framework snapshots without resolvable dependencies
  (`node_modules` is excluded from capture; unchanged).
- General hunk-level merge, dynamic selector ownership, SCSS/Less nesting
  rollback, CSS-in-JS style rollback.

Fixtures live in `fixtures/framework-lab/` (react-tsx, vue-sfc, svelte,
astro, angular, css-in-js) with unit coverage in
`test/unit/framework.test.ts`.
