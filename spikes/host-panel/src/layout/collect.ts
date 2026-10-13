import type { Page } from 'playwright-core';
import type { LayoutGuard } from './types';
import { validateGuard } from './types';
// Full bounds are for approved assertions, separate from clipped display/motion regions.
export async function checkGeometry(page: Page, guard: LayoutGuard) {
  validateGuard(guard);
  return page.evaluate((guard) => {
    if (guard.kind === 'horizontal-overflow') {
      const measured =
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
        window.innerWidth;
      return {
        outcome: measured > guard.tolerance ? ('fail' as const) : ('pass' as const),
        measured,
        message: `${Math.max(0, measured)}px horizontal overflow; tolerance ${guard.tolerance}px.`
      };
    }
    try {
      const elements = document.querySelectorAll(guard.selector!);
      const containers = document.querySelectorAll(guard.container!);
      if (elements.length !== 1 || containers.length !== 1)
        return { outcome: 'unknown' as const, message: 'Target or container missing/ambiguous.' };
      const element = elements[0],
        container = containers[0];
      if (!container.contains(element) || container === element)
        return {
          outcome: 'unknown' as const,
          message: 'Selected container is not a distinct ancestor.'
        };
      const hidden = [element, container].some((el) => {
        const style = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity) === 0 ||
          r.width <= 0 ||
          r.height <= 0
        );
      });
      if (hidden)
        return { outcome: 'unknown' as const, message: 'Target or container is not visible.' };
      const a = element.getBoundingClientRect(),
        b = container.getBoundingClientRect();
      const measured = Math.max(
        0,
        b.left - a.left,
        a.right - b.right,
        b.top - a.top,
        a.bottom - b.bottom
      );
      return {
        outcome: measured > guard.tolerance ? ('fail' as const) : ('pass' as const),
        measured,
        message: `${measured.toFixed(1)}px outside container bounds; tolerance ${guard.tolerance}px. Intentional overflow requires a different assertion.`
      };
    } catch {
      return { outcome: 'unknown' as const, message: 'Invalid geometry selector.' };
    }
  }, guard);
}
