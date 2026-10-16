// Runs inside the preview page (React development builds only). Never import
// modules here: this function is serialized into the page by the picker.
export interface FiberSourceFrame {
  fileName: string;
  lineNumber: number;
  columnNumber: number;
  functionName?: string;
}
export interface FiberPick {
  tag: string;
  frames: FiberSourceFrame[];
  components: string[];
}

/**
 * Reads React dev-only fiber metadata for a clicked element. React <19
 * exposes _debugSource (needs a JSX source transform); React 19 exposes
 * _debugStack, an Error captured at the JSX creation site. Production builds
 * carry neither and yield no frames, which the caller must refuse.
 */
export function fiberSourceScript(el: Element): FiberPick {
  const tag = el.tagName.toLowerCase();
  const key = Object.keys(el).find(
    (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  );
  const frames: FiberSourceFrame[] = [];
  const components: string[] = [];
  if (!key) return { tag, frames, components };
  const root: unknown = (el as unknown as Record<string, unknown>)[key];
  const seenStack = new Set<unknown>();
  // Pass 1: nearest creation-site frame (walks up from the host fiber).
  let fiber = root;
  while (fiber && typeof fiber === 'object' && frames.length < 1) {
    const f = fiber as {
      _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number };
      _debugStack?: { stack?: unknown };
      return?: unknown;
    };
    const ds = f._debugSource;
    if (ds && typeof ds.fileName === 'string' && typeof ds.lineNumber === 'number') {
      frames.push({
        fileName: ds.fileName,
        lineNumber: ds.lineNumber,
        columnNumber: ds.columnNumber ?? 1
      });
      break;
    }
    const stk = f._debugStack;
    if (stk && typeof stk.stack === 'string' && !seenStack.has(stk)) {
      seenStack.add(stk);
      const lines = String(stk.stack).split('\n');
      // First line is the error header, second is the jsxDEV factory frame.
      for (const line of lines.slice(2)) {
        if (/react[-_]stack[-_]bottom[-_]frame/.test(line)) break;
        const m = line.match(/\(?([^\s():]+\.(?:jsx|tsx|ts|js)):(\d+):(\d+)\)?/);
        if (!m) continue;
        if (
          m[1].includes('node_modules') ||
          m[1].includes('@vite') ||
          m[1].includes('react-refresh')
        )
          continue;
        frames.push({
          fileName: m[1],
          lineNumber: Number(m[2]),
          columnNumber: Number(m[3]),
          functionName: (line.match(/at\s+([^\s(]+)/) ?? [])[1]
        });
        break;
      }
    }
    fiber = f.return;
  }
  // Pass 2: enclosing component names, innermost first.
  fiber = root;
  while (fiber && typeof fiber === 'object' && components.length < 8) {
    const f = fiber as { type?: unknown; return?: unknown };
    if (typeof f.type === 'function') {
      const name = (f.type as { name?: string }).name;
      if (name && !components.includes(name)) components.push(name);
    }
    fiber = f.return;
  }
  return { tag, frames, components };
}
