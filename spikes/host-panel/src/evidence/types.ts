export interface RenderReceipt {
  version: 1;
  checkpoint: string;
  specification: string;
  source: string;
  lockfiles: { path: string; hash: string }[];
  browserVersion: string;
  browserIdentity: string;
  runtime: string;
  platform: string;
  viewport: { width: number; height: number };
  routeIdentity: string;
  commandIdentity: string;
  capturedAt: string;
  imageHash: string;
  geometryHash: string;
  dependencies: 'tracked-source-only';
  repeatability: 'not-rechecked' | 'repeatable-in-two-probes' | 'unstable';
  probes?: number;
}
