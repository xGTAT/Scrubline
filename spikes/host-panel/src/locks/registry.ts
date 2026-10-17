import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * A locked element must never be modified - by restores, by selective apply,
 * or by the IDE agent. The lock is advisory to the agent (surfaced over MCP)
 * and enforced wherever Scrubline itself writes: reverts touching a locked
 * element's document are flagged, and the UI Advisor sees locks as context.
 */
export interface LockedElement {
  /** CSS selector pinned to exactly one element (same contract as element picks). */
  selector: string;
  /** Document (HTML file) that owns the element. */
  document: string;
  /** Human-readable label, usually the element's accessible name or tag. */
  label?: string;
  /** ISO timestamp of when the lock was created. */
  lockedAt: string;
  /** Exact element HTML captured when the lock was set; renders the locked-elements preview. */
  pinnedHtml?: string;
  /** Checkpoint the pinned content came from. */
  sourceCheckpointId?: string;
  /** Branch the pinned content came from; 'main' when absent. */
  sourceBranch?: string;
}

function selectorsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  // Positional selectors describe a containment path, so a prefix overlaps.
  const pathLike = (s: string): boolean => s.startsWith('body');
  if (pathLike(a) && pathLike(b)) return a.startsWith(b) || b.startsWith(a);
  return false;
}

export class LockRegistry {
  private locks: LockedElement[] = [];
  private readonly file: string;

  constructor(storeRoot: string) {
    this.file = path.join(storeRoot, 'locks.json');
  }

  async open(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as LockedElement[];
      this.locks = Array.isArray(parsed)
        ? parsed.filter(
            (l): l is LockedElement =>
              typeof l?.selector === 'string' && typeof l?.document === 'string'
          )
        : [];
    } catch {
      this.locks = [];
    }
  }

  private async persist(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.locks, null, 2));
    await fs.rename(tmp, this.file);
  }

  list(): readonly LockedElement[] {
    return this.locks;
  }

  /**
   * Add a lock; replacing an existing lock on the same selector+document.
   * Throws when the same element is already locked with different pinned
   * content (e.g. locked from two different alternatives) - never silent.
   */
  async add(entry: Omit<LockedElement, 'lockedAt'>): Promise<LockedElement> {
    const conflicting = this.locks.find(
      (l) =>
        l.document === entry.document &&
        selectorsOverlap(l.selector, entry.selector) &&
        !!l.pinnedHtml &&
        !!entry.pinnedHtml &&
        l.pinnedHtml !== entry.pinnedHtml
    );
    if (conflicting) {
      throw new Error(
        `Conflicting locked elements: ${entry.selector} in ${entry.document} is already locked with different content` +
          (conflicting.sourceBranch || entry.sourceBranch
            ? ` (locked from '${conflicting.sourceBranch ?? 'main'}', new lock from '${entry.sourceBranch ?? 'main'}')`
            : '') +
          '. Unlock the existing one first.'
      );
    }
    const locked: LockedElement = { ...entry, lockedAt: new Date().toISOString() };
    this.locks = [
      ...this.locks.filter(
        (l) => !(l.selector === entry.selector && l.document === entry.document)
      ),
      locked
    ];
    await this.persist();
    return locked;
  }

  async remove(selector: string, document: string): Promise<boolean> {
    const before = this.locks.length;
    this.locks = this.locks.filter((l) => !(l.selector === selector && l.document === document));
    if (this.locks.length !== before) await this.persist();
    return this.locks.length !== before;
  }

  isLocked(selector: string, document: string): boolean {
    return this.locks.some((l) => l.selector === selector && l.document === document);
  }

  /**
   * Locks whose owning document appears in the given changed paths. Used to
   * flag checkpoints and reverts that touched a locked element's file.
   */
  touchedBy(changedPaths: readonly string[]): LockedElement[] {
    const changed = new Set(changedPaths);
    return this.locks.filter((l) => changed.has(l.document));
  }
}
