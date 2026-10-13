import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HistoryStore, hashBytes } from '../store/store';
import { PreviewRunner, type PreviewConfig } from '../preview/runner';
import { scan, changedPaths, type ScanLimits } from '../capture/scanner';
import { ancestry } from './history';
import { declarationChanges, applyUnits, type CssUnit } from './change-units';
import { minimize, type Outcome } from './minimize';
import type { Investigation, InvestigationRequest } from './types';
import { validateGuard } from '../layout/types';
export async function investigate(
  store: HistoryStore,
  config: PreviewConfig,
  limits: ScanLimits,
  request: InvestigationRequest,
  cancelled: () => boolean,
  notify: (state: Investigation) => void
) {
  validateGuard(request.guard);
  if (!Number.isInteger(request.budget) || request.budget < 1 || request.budget > 32)
    throw new Error('Choose a probe budget from 1 to 32.');
  const chain = ancestry(store.checkpoints, request.good, request.bad);
  const state: Investigation = {
    running: true,
    message: 'Checking saved ancestry with fresh probes.',
    transitions: [],
    observations: [],
    units: [],
    probes: 0,
    trials: []
  };
  const publish = () =>
    notify({
      ...state,
      units: [...state.units],
      observations: [...state.observations],
      transitions: [...state.transitions]
    });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-investigation-'));
  const tempStore = new HistoryStore(path.join(directory, 'history'));
  try {
    await tempStore.open();
    publish();
    const probe = async (
      cp: import('../bridge/timeline').Checkpoint,
      source = store,
      subset?: string[]
    ): Promise<Outcome> => {
      if (cancelled()) return 'unknown';
      const runner = new PreviewRunner(
        { ...config, guard: request.guard, port: config.port + 5 },
        source
      );
      try {
        const rendered = await runner.historical(cp, true, 'investigation-probes');
        state.probes++;
        publish();
        const outcome: Outcome =
          !rendered.url || !rendered.screenshot
            ? 'unknown'
            : JSON.parse(await fs.readFile(`${rendered.screenshot}.layout.json`, 'utf8')).outcome;
        state.trials!.push({ source: hashBytes(JSON.stringify(cp.files)), outcome, subset });
        return outcome;
      } catch {
        state.trials!.push({
          source: hashBytes(JSON.stringify(cp.files)),
          outcome: 'unknown',
          subset
        });
        return 'unknown';
      } finally {
        await runner.stop();
      }
    };
    for (const cp of chain) {
      if (cancelled()) throw new Error('Investigation cancelled.');
      const outcome = await probe(cp);
      state.observations.push({ checkpoint: cp.id, outcome });
      publish();
    }
    if (state.observations[0].outcome !== 'pass' || state.observations.at(-1)!.outcome !== 'fail')
      throw new Error('Endpoints must freshly pass and fail under the same assertion.');
    for (let i = 1; i < chain.length; i++)
      if (state.observations[i - 1].outcome === 'pass' && state.observations[i].outcome === 'fail')
        state.transitions.push({ good: chain[i - 1].id, bad: chain[i].id });
    if (state.observations.some((o) => o.outcome === 'unknown'))
      throw new Error('Unknown saved-state result; culprit localization refused.');
    if ((await probe(chain[0])) !== 'pass' || (await probe(chain.at(-1)!)) !== 'fail')
      throw new Error('Endpoints are unstable across fresh probes.');
    const transition = state.transitions[0];
    if (!transition) throw new Error('No observed passing-to-failing transition.');
    const good = chain.find((c) => c.id === transition.good)!,
      bad = chain.find((c) => c.id === transition.bad)!;
    const paths = changedPaths(good.files, bad.files);
    if (!paths.length || paths.some((p) => !p.endsWith('.css')))
      throw new Error(
        'Localization requires CSS-only changed paths. Transition evidence remains available.'
      );
    const bases = new Map<string, string>();
    const units: CssUnit[] = [];
    for (const p of paths) {
      const a = good.files.find((f) => f.path === p),
        b = bad.files.find((f) => f.path === p);
      if (!a || !b || a.mode !== b.mode)
        throw new Error('CSS file structure/mode change unsupported.');
      const before = (await store.readBlob(a.hash)).toString('utf8'),
        after = (await store.readBlob(b.hash)).toString('utf8');
      bases.set(p, before);
      units.push(...declarationChanges(p, before, after));
    }
    if (!units.length || units.length > 16)
      throw new Error(
        'Choose a transition with 1 to 16 uniquely mapped declaration value changes.'
      );
    state.message = 'Testing isolated declaration subsets. Original workspace untouched.';
    publish();
    const subsetProbe = async (subset: CssUnit[]) => {
      const candidate = path.join(directory, 'candidate');
      await fs.rm(candidate, { recursive: true, force: true });
      await store.materialize(good, candidate);
      for (const [p, before] of bases)
        await fs.writeFile(
          path.join(candidate, p),
          applyUnits(
            before,
            subset.filter((u) => u.path === p)
          )
        );
      const captured = await scan(candidate, tempStore.root, limits);
      const cp = await tempStore.commit(captured.files, captured.contents, 'reconcile', {
        kind: 'unattributed'
      });
      return probe(
        cp,
        tempStore,
        subset.map((u) => `${u.path}:${u.key}`)
      );
    };
    if ((await subsetProbe([])) !== 'pass' || (await subsetProbe(units)) !== 'fail')
      throw new Error('Parsed counterfactual endpoints did not reproduce the assertion.');
    const result = await minimize(units, subsetProbe, request.budget, cancelled);
    state.units = result.units;
    state.minimal = result.minimal;
    state.message = result.cancelled
      ? 'Investigation cancelled.'
      : result.minimal
        ? '1-minimal declaration set under this assertion and search. Not a unique root cause.'
        : 'Budget-limited or unresolved declaration set; minimality not established.';
    await fs.mkdir(path.join(store.root, 'investigations'), { recursive: true });
    const record = JSON.stringify({
      ...state,
      running: false,
      request,
      specification: hashBytes(JSON.stringify(config))
    });
    if (record.length > 1024 * 1024) throw new Error('Investigation evidence too large.');
    const files = await fs.readdir(path.join(store.root, 'investigations'));
    if (files.length >= 20) throw new Error('Investigation record limit reached (20).');
    await fs.writeFile(
      path.join(store.root, 'investigations', hashBytes(record) + '.json'),
      record,
      { flag: 'wx' }
    );
  } catch (e) {
    state.message = e instanceof Error ? e.message : 'Investigation failed.';
  } finally {
    state.running = false;
    publish();
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(path.join(store.root, 'investigation-probes'), { recursive: true, force: true });
  }
  return state;
}
