import { redact } from './redact';
import type { Checkpoint } from '../bridge/timeline';
import { changedPaths } from '../capture/scanner';
export interface Selection {
  selector: string;
  tag: string;
  name: string;
  snippet: string;
  route: string;
  fingerprint: string;
}
export interface ContextPacket {
  checkpoint: string;
  selector: string;
  name: string;
  route: string;
  snippet: string;
  summary: string;
  body: string;
  crop?: string;
  status: 'ready' | 'stale';
}
export function makePacket(
  c: Checkpoint,
  previous: Checkpoint | undefined,
  selection: Selection,
  secrets: readonly string[] = [],
  crop?: string
): ContextPacket {
  const paths = changedPaths(previous?.files ?? [], c.files);
  const summary = `${paths.length} file${paths.length === 1 ? '' : 's'} changed. Selected area: ${selection.tag}${selection.name ? ` (${selection.name})` : ''}. No source mapping inferred.`;
  const fields = {
    checkpoint: c.id,
    selector: redact(selection.selector, secrets),
    name: redact(selection.name, secrets),
    route: redact(selection.route.split(/[?#]/)[0], secrets),
    snippet: redact(selection.snippet, secrets),
    summary: redact(summary, secrets)
  };
  const body = redact(
    `Checkpoint: ${fields.checkpoint}\nSelector (best effort): ${fields.selector}\nAccessible name: ${fields.name}\nRoute: ${fields.route}\nDOM: ${fields.snippet}\nChanges: ${fields.summary}\nFiles:\n${paths.map((p) => `- ${p}`).join('\n')}\nPaste manually into Antigravity. No automatic submission.`,
    secrets
  );
  return { ...fields, body, crop, status: 'ready' };
}
