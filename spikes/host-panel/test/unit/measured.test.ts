import { test, expect } from 'vitest';
import { budgetPacket, measuredPacket } from '../../src/targeting/measured';
import { HistoryStore } from '../../src/store/store';
import { scan } from '../../src/capture/scanner';
import { declarationChanges } from '../../src/investigation/change-units';
import { specificationKey } from '../../src/preview/spec';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
test('byte budget omits whole contradictory evidence section and redacts before counting', () => {
  const sections = [
    { reason: 'assertion', text: 'API_KEY=private-key person@example.com' },
    { reason: 'complete outcome set', text: 'fail pass unknown '.repeat(1000) }
  ];
  const a = budgetPacket(sections, [], 1000),
    b = budgetPacket(sections, [], 1000);
  expect(a).toEqual(b);
  expect(a.bytes).toBeLessThanOrEqual(1000);
  expect(a.body).not.toContain('private-key');
  expect(a.body).not.toContain('person@example.com');
  expect(a.body).toContain('Omitted: complete outcome set');
  expect(a.body).not.toContain('fail pass');
});
test('measured packet binds exact CSS spans, all outcomes and current specification', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-measured-'));
  try {
    const work = path.join(root, 'project');
    await fs.mkdir(work);
    const store = new HistoryStore(path.join(root, 'history'));
    await store.open();
    const capture = async (text: string) => {
      await fs.writeFile(path.join(work, 'site.css'), text);
      const s = await scan(work, store.root);
      return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    };
    const before = 'nav{min-width:0px}',
      after = 'nav{min-width:900px}';
    const good = await capture(before),
      bad = await capture(after);
    const config = { command: 'node server.cjs', port: 4100, timeoutMs: 3000 };
    const investigation = {
      running: false,
      request: {
        good: good.id,
        bad: bad.id,
        budget: 8,
        guard: { kind: 'horizontal-overflow' as const, tolerance: 1 }
      },
      specification: specificationKey(config),
      message: 'conditional 1-minimal',
      transitions: [{ good: good.id, bad: bad.id }],
      observations: [
        { checkpoint: good.id, outcome: 'pass' as const },
        { checkpoint: bad.id, outcome: 'fail' as const }
      ],
      trials: [
        { source: 'abc', outcome: 'unknown' as const },
        { source: 'def', outcome: 'fail' as const }
      ],
      probes: 2,
      units: declarationChanges('site.css', before, after)
    };
    const p = await measuredPacket(store, investigation, config, []);
    expect(p.body).toContain('site.css:1:5');
    expect(p.body).toContain('unknown');
    expect(p.body).toContain('Render receipt omitted');
    expect(p.bytes).toBe(Buffer.byteLength(p.body));
    await expect(
      measuredPacket(store, investigation, { ...config, width: 390 }, [])
    ).rejects.toThrow('stale');
    await expect(
      measuredPacket(store, { ...investigation, units: [] }, config, [])
    ).rejects.toThrow('source-mapped');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
