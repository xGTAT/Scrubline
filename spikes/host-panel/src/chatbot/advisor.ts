import type { DesignQueryContext, DesignAdviceResponse } from './types';
import { DesignAnalyzer } from './analyzer';

export interface DesignAdvisorProvider {
  readonly name: string;
  generateAdvice(context: DesignQueryContext): Promise<DesignAdviceResponse>;
}

export class DeterministicAdvisorProvider implements DesignAdvisorProvider {
  readonly name = 'deterministic-heuristics';
  private analyzer = new DesignAnalyzer();

  async generateAdvice(context: DesignQueryContext): Promise<DesignAdviceResponse> {
    return this.analyzer.analyze(context);
  }
}

export class DesignAdvisorService {
  private provider: DesignAdvisorProvider;

  constructor(provider?: DesignAdvisorProvider) {
    this.provider = provider ?? new DeterministicAdvisorProvider();
  }

  setProvider(provider: DesignAdvisorProvider) {
    this.provider = provider;
  }

  getProviderName(): string {
    return this.provider.name;
  }

  async ask(context: DesignQueryContext): Promise<DesignAdviceResponse> {
    return this.provider.generateAdvice(context);
  }
}
