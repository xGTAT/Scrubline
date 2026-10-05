import * as fs from 'node:fs/promises';
import type { Attribution, Checkpoint, TimelineState } from '../bridge/timeline';
import { HistoryStore, hashBytes } from '../store/store';
import { scan, changedPaths, defaultLimits, type ScanLimits } from './scanner';

export class Timeline {
  state: TimelineState = { status: 'loading', rows: [], unsaved: false };
  private timer?: ReturnType<typeof setTimeout>;
  private bounded?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private opened = false;
  private consumed = new Set<string>();
  constructor(
    readonly workspace: string,
    readonly store: HistoryStore,
    private notify: (state: TimelineState) => void,
    readonly limits: ScanLimits = defaultLimits,
    readonly hookLog?: string
  ) {}
  async start(reconcileMs = 30000) {
    try {
      await this.store.acquireWriter();
      await this.store.open();
      this.opened = true;
      if (this.hookLog) {
        try {
          for (const line of (await fs.readFile(this.hookLog, 'utf8'))
            .split('\n')
            .filter(Boolean)) {
            try {
              this.consumed.add(hashBytes(JSON.stringify(JSON.parse(line))));
            } catch {
              /* Ignore incomplete metadata. */
            }
          }
        } catch {
          /* Optional metadata. */
        }
      }
      await this.capture('baseline');
    } catch (e) {
      this.failure(e);
    }
    this.interval = setInterval(() => void this.capture('reconcile'), reconcileMs);
  }
  dirty(value: boolean) {
    this.state = { ...this.state, unsaved: value };
    this.notify(this.state);
  }
  event(trigger: 'watcher' | 'save') {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const run = () => {
      if (this.timer) clearTimeout(this.timer);
      if (this.bounded) clearTimeout(this.bounded);
      this.timer = undefined;
      this.bounded = undefined;
      void this.capture(trigger);
    };
    this.timer = setTimeout(run, 300);
    this.bounded ??= setTimeout(run, 2000);
  }
  capture(trigger: Checkpoint['trigger']): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        if (!this.opened) {
          await this.store.acquireWriter();
          await this.store.open();
          this.opened = true;
        }
        // Two equal hash scans avoid committing the common mid-edit race.
        const first = await scan(this.workspace, this.store.root, this.limits);
        const current = await scan(this.workspace, this.store.root, this.limits);
        if (changedPaths(first.files, current.files).length)
          throw new Error('Files changed during capture. Retry.');
        const previous = this.store.checkpoints.at(-1);
        const changed = changedPaths(previous?.files ?? [], current.files);
        if (!previous || changed.length) {
          const attribution = await this.attribution(current.files, changed);
          await this.store.commit(current.files, current.contents, trigger, attribution);
        }
        const parents = new Map(this.store.checkpoints.map((c) => [c.id, c]));
        this.state = {
          status: 'ready',
          rows: this.store.checkpoints
            .filter((c) => !c.branch)
            .map((c) => ({
              id: c.id,
              createdAt: c.createdAt,
              attribution: c.attribution,
              changedPaths: changedPaths(parents.get(c.parentId ?? '')?.files ?? [], c.files)
            })),
          unsaved: this.state.unsaved
        };
        this.notify(this.state);
      } catch (e) {
        this.failure(e);
      }
    });
    return this.queue;
  }
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(
      () => {},
      () => {}
    );
    return result;
  }
  private async attribution(files: Checkpoint['files'], changed: string[]): Promise<Attribution> {
    if (!this.hookLog) return { kind: 'unattributed' };
    try {
      if ((await fs.stat(this.hookLog)).size > 1024 * 1024) return { kind: 'unattributed' };
      const records = (await fs.readFile(this.hookLog, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        });
      const fingerprint = hashBytes(await fs.realpath(this.workspace));
      const matches = records.filter(
        (r) =>
          r &&
          !this.consumed.has(hashBytes(JSON.stringify(r))) &&
          r.event === 'post-tool' &&
          r.workspace === fingerprint &&
          typeof r.tool === 'string' &&
          r.tool.length < 120 &&
          typeof r.targetFile === 'string' &&
          changed.includes(r.targetFile) &&
          files.some((f) => f.path === r.targetFile && f.hash === r.contentHash)
      );
      const r = matches.at(-1);
      for (const record of records)
        if (record) this.consumed.add(hashBytes(JSON.stringify(record)));
      if (r)
        return {
          kind: 'hook',
          tool: r.tool,
          paths: [r.targetFile],
          ...(typeof r.conversation === 'string' && /^[a-f0-9]{12}$/.test(r.conversation)
            ? { conversation: r.conversation }
            : {}),
          ...(Number.isInteger(r.stepIdx) ? { stepIdx: r.stepIdx } : {})
        };
    } catch {
      /* Missing metadata never invents authorship. */
    }
    return { kind: 'unattributed' };
  }
  private failure(e: unknown) {
    const message = e instanceof Error ? e.message : 'Capture failed.';
    this.state = {
      ...this.state,
      status: message.toLowerCase().includes('limit') ? 'limit' : 'error',
      message
    };
    this.notify(this.state);
  }
  async dispose() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.bounded) clearTimeout(this.bounded);
    if (this.interval) clearInterval(this.interval);
    await this.queue;
    await this.store.releaseWriter();
  }
      }
