import postcss from 'postcss';
import { HistoryStore, hashBytes } from '../store/store';
import type { Investigation } from '../investigation/types';
import type { PreviewConfig } from '../preview/runner';
import { specificationKey } from '../preview/spec';
import { declarationChanges } from '../investigation/change-units';
import type { RenderReceipt } from '../evidence/types';
import { redact } from './redact';
export interface MeasuredPacket {
  body: string;
  bytes: number;
  tokenUpperEstimate: number;
  identity: string;
  checkpoint: string;
  specification: string;
}
export function budgetPacket(
  sections: { reason: string; text: string }[],
  secrets: readonly string[],
  limit = 12000
) {
  if (!Number.isInteger(limit) || limit < 1000 || limit > 24000)
    throw new Error('Packet budget must be 1000-24000 bytes.');
  const included: string[] = [],
    omitted: string[] = [];
  let used = 0;
  for (const section of sections) {
    const text = redact(section.text, secrets);
    const cost = Buffer.byteLength(text + '\n\n');
    if (used + cost <= limit - 700) {
      included.push(text);
      used += cost;
    } else omitted.push(section.reason);
  }
  const footer = `Budget: ${limit} UTF-8 bytes maximum. Whole sections only; no evidence lines cut.\nOmitted: ${omitted.join('; ') || 'none'}.\nToken count is not measured. Conservative byte-based estimate, not a model tokenizer.\nText only. Screenshots/crops excluded; review sanitized visuals separately. No automatic submission. Paste manually.`;
  const body = included.join('\n\n') + '\n\n' + footer;
  if (Buffer.byteLength(body) > limit) throw new Error('Packet footer exceeds budget.');
  return { body, bytes: Buffer.byteLength(body), tokenUpperEstimate: Buffer.byteLength(body) };
}
export async function measuredPacket(
  store: HistoryStore,
  value: Investigation,
  config: PreviewConfig,
  secrets: readonly string[],
  receipt?: RenderReceipt,
  existing?: string
): Promise<MeasuredPacket> {
  if (value.running || !value.request || !value.transitions.length || !value.units.length)
    throw new Error('Complete source-mapped investigation first.');
  const specification = specificationKey(config);
  if (value.specification !== specification)
    throw new Error('Investigation settings are stale. Investigate again.');
  const transition = value.transitions[0];
  const good = store.checkpoints.find((c) => c.id === transition.good),
    bad = store.checkpoints.find((c) => c.id === transition.bad);
  if (!good || !bad) throw new Error('Historical source unavailable.');
  const spans: string[] = [];
  for (const unit of value.units) {
    const a = good.files.find((f) => f.path === unit.path),
      b = bad.files.find((f) => f.path === unit.path);
    if (!a || !b) throw new Error('Source span unavailable.');
    const before = (await store.readBlob(a.hash)).toString('utf8'),
      after = (await store.readBlob(b.hash)).toString('utf8');
    if (
      !declarationChanges(unit.path, before, after).some(
        (u) => JSON.stringify(u) === JSON.stringify(unit)
      )
    )
      throw new Error('Source declaration changed.');
    const root = postcss.parse(after);
    let span = '';
    root.walkDecls((d) => {
      if (
        d.prop === unit.property &&
        d.parent?.type === 'rule' &&
        d.parent.selector === unit.selector &&
        d.value + (d.important ? ' !important' : '') === unit.after
      ) {
        const start = d.source?.start,
          end = d.source?.end;
        if (span || !start || !end) throw new Error('Ambiguous declaration span.');
        span = `${unit.path}:${start.line}:${start.column}-${end.line}:${end.column} blob ${b.hash}\n${unit.selector} / ${unit.property}: ${unit.before} -> ${unit.after}`;
      }
    });
    if (!span) throw new Error('Declaration span unavailable.');
    spans.push(span);
  }
  const sections = [
    {
      reason: 'assertion and historical transition',
      text: `Measured repair context\nAssertion: ${JSON.stringify(value.request.guard)}\nGood: ${transition.good}\nBad: ${transition.bad}\nSpecification: ${specification}\nClaim: ${value.message}\nNo unique root cause, global minimality or AI-turn attribution.`
    },
    {
      reason: 'verified source spans',
      text: `Included for exact CSS ownership:\n${spans.join('\n')}`
    },
    {
      reason: 'all counterfactual outcomes, including contradictions',
      text: `Included as one complete outcome set, not cherry-picked:\n${JSON.stringify({ observations: value.observations, transitions: value.transitions, trials: value.trials ?? [], probes: value.probes })}`
    },
    {
      reason: 'matching render receipt',
      text:
        receipt?.checkpoint === bad.id && receipt.specification === specification
          ? `Included for render provenance:\n${JSON.stringify(receipt)}`
          : 'Render receipt omitted: no matching bad-checkpoint/specification receipt. Investigation outcomes are not retained screenshot proof.'
    },
    {
      reason: 'reviewed selected DOM context',
      text:
        existing ?? 'Selected DOM omitted: no reviewed element selection. CSS source mapping only.'
    }
  ];
  const result = budgetPacket(sections, secrets);
  return { ...result, identity: hashBytes(result.body), checkpoint: bad.id, specification };
}
