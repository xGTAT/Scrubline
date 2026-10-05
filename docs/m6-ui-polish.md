# M6 UI and motion acceptance

Owner steering, October 5: "Make the UI look modern and professional at the end with industry level animations baked in."

The final UI must be reviewed as a coherent product, not a collection of working controls. Preserve the plan's narrow-sidebar focus, theme-bound colors, concise copy, typography, keyboard operation and accessibility gates.

- M2/M3 establish layout, preview/review states, consistent spacing and clear selection feedback.
- M6 refines hierarchy, density, responsive layouts, error/loading/empty states and interaction details across dark, light and high-contrast themes.
- Motion explains state changes: read-only scrubbing can crossfade; View Transitions require matching element identity. Selection and panel changes use restrained transform/opacity. Avoid decorative continuous movement and layout-shifting animation.
- Reduced-motion is tested: crossfades become instant, no essential information depends on animation, keyboard/screen-reader flows remain complete.
- Inspect rendered pixels and clips of the actual transitions, not merely CSS properties. Check frame stability and responsiveness with large histories on the owner's integrated-graphics Windows machine. Human judgment of the final visual feel remains required.

This is a release acceptance item, not a substitute for M1 recovery or M2 restore safety.
