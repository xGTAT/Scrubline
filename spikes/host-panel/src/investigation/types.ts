import type { LayoutGuard } from '../layout/types';
import type { CssUnit } from './change-units';
export interface Investigation {
  running: boolean;
  request?: InvestigationRequest;
  specification?: string;
  message: string;
  transitions: { good: string; bad: string }[];
  observations: { checkpoint: string; outcome: 'pass' | 'fail' | 'unknown' }[];
  units: CssUnit[];
  probes: number;
  trials?: { source: string; outcome: 'pass' | 'fail' | 'unknown'; subset?: string[] }[];
  minimal?: boolean;
}
export interface InvestigationRequest {
  good: string;
  bad: string;
  guard: LayoutGuard;
  budget: number;
}
