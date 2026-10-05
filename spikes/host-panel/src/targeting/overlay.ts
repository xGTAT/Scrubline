// This function is injected only into an opt-in, loopback preview page.
export function installOverlay() {
  type Candidate = {
    selector: string;
    tag: string;
    name: string;
    snippet: string;
    route: string;
    fingerprint: string;
  };
  const win = window as typeof window & {
    __scrublineStopped?: () => void;
    __scrublineSelect?: (value: Candidate) => Promise<void>;
    __scrublineTarget?: {
      selected?: Candidate;
      enable: () => void;
      disable: () => void;
      validate: () => boolean;
    };
  };
  win.__scrublineTarget?.disable();
  const banner = document.createElement('div');
  banner.id = 'scrubline-target-indicator';
  banner.textContent = 'Scrubline targeting on · Esc to stop';
  banner.setAttribute('role', 'status');
  Object.assign(banner.style, {
    position: 'fixed',
    top: '8px',
    right: '8px',
    zIndex: '2147483647',
    padding: '10px 14px',
    background: '#1d3550',
    color: '#fff',
    font: '13px system-ui',
    border: '1px solid #aacbed',
    borderRadius: '5px',
    pointerEvents: 'none'
  });
  const highlight = document.createElement('div');
  highlight.setAttribute('aria-hidden', 'true');
  Object.assign(highlight.style, {
    position: 'fixed',
    zIndex: '2147483646',
    border: '2px solid #87bfff',
    background: 'rgba(80,150,255,.08)',
    pointerEvents: 'none',
    display: 'none'
  });
  let selected: Candidate | undefined;
  let enabled = false;
  const fingerprint = (e: Element) =>
    JSON.stringify({
      tag: e.tagName,
      name: (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 300),
      id: e.id,
      testid: e.getAttribute('data-testid'),
      role: e.getAttribute('role'),
      href: e.getAttribute('href')
    });
  const selectorFor = (e: Element): string | undefined => {
    if (e.id) {
      const s = '#' + CSS.escape(e.id);
      if (document.querySelectorAll(s).length === 1) return s;
    }
    const testid = e.getAttribute('data-testid');
    if (testid) {
      const s = '[data-testid="' + CSS.escape(testid) + '"]';
      if (document.querySelectorAll(s).length === 1) return s;
    }
    const parts: string[] = [];
    let node: Element | null = e;
    while (node && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node!.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      const s = parts.join(' > ');
      if (document.querySelectorAll(s).length === 1) return s;
      node = parent;
    }
    return undefined;
  };
  const move = (event: MouseEvent) => {
    const e = event.target;
    if (!(e instanceof Element) || e === banner || e === highlight) return;
    const b = e.getBoundingClientRect();
    Object.assign(highlight.style, {
      display: 'block',
      left: b.x + 'px',
      top: b.y + 'px',
      width: b.width + 'px',
      height: b.height + 'px'
    });
  };
  const click = (event: MouseEvent) => {
    const e = event.target;
    if (!(e instanceof Element) || e === banner || e === highlight) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const selector = selectorFor(e);
    if (!selector) return;
    const labelled = e.getAttribute('aria-labelledby');
    const name =
      e.getAttribute('aria-label') ??
      (labelled
        ? labelled
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
        : null) ??
      e.getAttribute('alt') ??
      (e as HTMLInputElement).labels?.[0]?.textContent ??
      e.textContent ??
      '';
    selected = {
      selector,
      tag: e.tagName.toLowerCase(),
      name: name.trim().slice(0, 300),
      snippet: `<${e.tagName.toLowerCase()}>${(e.textContent ?? '').trim().slice(0, 500)}</${e.tagName.toLowerCase()}>`,
      route: location.pathname,
      fingerprint: fingerprint(e)
    };
    void win.__scrublineSelect?.(selected);
    move(event);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      disable();
      win.__scrublineStopped?.();
    }
  };
  function enable() {
    if (enabled) return;
    enabled = true;
    document.body.append(banner, highlight);
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
  }
  function disable() {
    enabled = false;
    banner.remove();
    highlight.remove();
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', key, true);
  }
  function validate() {
    if (!selected) return false;
    try {
      const all = document.querySelectorAll(selected.selector);
      return all.length === 1 && fingerprint(all[0]) === selected.fingerprint;
    } catch {
      return false;
    }
  }
  win.__scrublineTarget = {
    get selected() {
      return selected;
    },
    enable,
    disable,
    validate
  };
  if (document.body) enable();
  else document.addEventListener('DOMContentLoaded', enable, { once: true });
}
