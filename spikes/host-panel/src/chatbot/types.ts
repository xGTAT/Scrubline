import type { Checkpoint } from '../bridge/timeline';
import type { CssUnit } from '../investigation/change-units';
import type { RenderReceipt } from '../evidence/types';

export type EvidenceCategory =
  | 'source_code'
  | 'css_ast'
  | 'html_structure'
  | 'rendered_geometry'
  | 'screenshot'
  | 'historical_diff';

export interface EvidenceItem {
  category: EvidenceCategory;
  file?: string;
  line?: number;
  selector?: string;
  property?: string;
  value?: string;
  description: string;
  verified: boolean;
}

export type DesignCategory =
  | 'spacing'
  | 'typography'
  | 'layout'
  | 'color_consistency'
  | 'accessibility'
  | 'visual_hierarchy'
  | 'diff_comparison'
  | 'general';

export interface DesignRecommendation {
  id: string;
  category: DesignCategory;
  priority: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  rationale: string;
  tradeOffs: string;
  suggestedCode?: string;
  targetFile?: string;
  evidence: EvidenceItem[];
}

export interface DesignAnalysisFinding {
  type: 'observation' | 'issue' | 'praise' | 'limitation';
  category: DesignCategory;
  title: string;
  details: string;
  evidence: EvidenceItem[];
}

export interface VisualEvidenceStatus {
  hasScreenshot: boolean;
  screenshotPath?: string;
  hasRegions: boolean;
  regionCount: number;
  hasReceipt: boolean;
  receipt?: RenderReceipt;
  limitations: string[];
}

export interface DesignQueryContext {
  activeCheckpoint: Checkpoint;
  compareCheckpoint?: Checkpoint;
  targetFiles: {
    path: string;
    content: string;
    isHtml: boolean;
    isCss: boolean;
  }[];
  cssDeclarations: {
    path: string;
    selector: string;
    property: string;
    value: string;
  }[];
  cssChanges?: CssUnit[];
  htmlElements: {
    tag: string;
    id?: string;
    classes: string[];
    role?: string;
    ariaLabel?: string;
    textSnippet?: string;
  }[];
  visual: VisualEvidenceStatus;
  userQuery: string;
  /** Elements locked by the user: never suggest changing these; advise instead. */
  lockedElements?: { selector: string; document: string; label?: string }[];
}

export interface DesignAdviceResponse {
  id: string;
  timestamp: string;
  query: string;
  checkpointId: string;
  compareCheckpointId?: string;
  summary: string;
  directAnswer: string;
  findings: DesignAnalysisFinding[];
  recommendations: DesignRecommendation[];
  visualEvidence: VisualEvidenceStatus;
  disclaimers: string[];
  suggestedSnippets: {
    title: string;
    language: string;
    code: string;
    targetFile?: string;
  }[];
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'advisor';
  timestamp: string;
  text: string;
  advice?: DesignAdviceResponse;
}

export interface ChatbotState {
  messages: ChatMessage[];
  busy: boolean;
  activeCheckpointId?: string;
  compareCheckpointId?: string;
  error?: string;
}
