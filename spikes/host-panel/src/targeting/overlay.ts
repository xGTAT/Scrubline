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
    __scrublineSelect?: (value: Candidate, all?: Candidate[]) => Promise<void>;
    __scrublineTarget?: {
      selected?: Candidate;
      selections?: Candidate[];
      enable: () => void;
      disable: () => void;
      validate: () => boolean;
      clear: () => void;
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
  const badgesContainer = document.createElement('div');
  badgesContainer.id = 'scrubline-badges-container';
  badgesContainer.setAttribute('aria-hidden', 'true');
  Object.assign(badgesContainer.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    zIndex: '2147483645'
  });

  let selected: Candidate | undefined;
  let selections: Candidate[] = [];
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
  const updateBadges = () => {
    badgesContainer.innerHTML = '';
    selections.forEach((s, idx) => {
      try {
        const el = document.querySelector(s.selector);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const badge = document.createElement('div');
        badge.textContent = String(idx + 1);
        Object.assign(badge.style, {
          position: 'fixed',
          left: `${rect.left}px`,
          top: `${Math.max(0, rect.top - 18)}px`,
          background: '#0969da',
          color: '#ffffff',
          fontSize: '11px',
          fontWeight: 'bold',
          lineHeight: '18px',
          minWidth: '18px',
          height: '18px',
          padding: '0 4px',
          borderRadius: '9px',
          textAlign: 'center',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          border: '1px solid #ffffff',
          pointerEvents: 'none',
          zIndex: '2147483647'
        });
        const box = document.createElement('div');
        Object.assign(box.style, {
          position: 'fixed',
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          border: '2px solid #0969da',
          background: 'rgba(9, 105, 218, 0.12)',
          pointerEvents: 'none',
          zIndex: '2147483646'
        });
        badgesContainer.append(box, badge);
      } catch {
        // The hovered element detached mid-pick; skip its badge.
      }
    });
  };
  const move = (event: MouseEvent) => {
    const e = event.target;
    if (!(e instanceof Element) || e === banner || e === highlight || badgesContainer.contains(e))
      return;
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
    if (!(e instanceof Element) || e === banner || e === highlight || badgesContainer.contains(e))
      return;
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
    const candidate: Candidate = {
      selector,
      tag: e.tagName.toLowerCase(),
      name: name.trim().slice(0, 300),
      snippet: `<${e.tagName.toLowerCase()}>${(e.textContent ?? '').trim().slice(0, 500)}</${e.tagName.toLowerCase()}>`,
      route: location.pathname,
      fingerprint: fingerprint(e)
    };
    const existingIndex = selections.findIndex((s) => s.selector === selector);
    if (existingIndex >= 0) {
      selections.splice(existingIndex, 1);
      selected = selections.at(-1);
    } else {
      selections.push(candidate);
      selected = candidate;
    }
    updateBadges();
    void win.__scrublineSelect?.(candidate, selections);
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
    document.body.append(banner, highlight, badgesContainer);
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', updateBadges, true);
    window.addEventListener('resize', updateBadges, true);
  }
  function disable() {
    enabled = false;
    banner.remove();
    highlight.remove();
    badgesContainer.remove();
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('scroll', updateBadges, true);
    window.removeEventListener('resize', updateBadges, true);
  }
  function validate() {
    const list = selections.length > 0 ? selections : selected ? [selected] : [];
    if (list.length === 0) return false;
    try {
      return list.every((item) => {
        const all = document.querySelectorAll(item.selector);
        return all.length === 1 && fingerprint(all[0]) === item.fingerprint;
      });
    } catch {
      return false;
    }
  }
  function clear() {
    selections = [];
    selected = undefined;
    updateBadges();
  }
  win.__scrublineTarget = {
    get selected() {
      return selected;
    },
    get selections() {
      return [...selections];
    },
    enable,
    disable,
    validate,
    clear
  };
  if (document.body) enable();
  else document.addEventListener('DOMContentLoaded', enable, { once: true });
}
