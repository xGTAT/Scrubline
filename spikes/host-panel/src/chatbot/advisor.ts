import type { DesignQueryContext, DesignAdviceResponse } from './types';

export interface DesignAdvisorProvider {
  readonly name: string;
  generateAdvice(context: DesignQueryContext): Promise<DesignAdviceResponse>;
}

export class DesignAdvisorService {
  private provider: DesignAdvisorProvider;
  private fallback?: DesignAdvisorProvider;
  private lastUsedProviderName: string;

  constructor(provider: DesignAdvisorProvider, fallback?: DesignAdvisorProvider) {
    this.provider = provider;
    this.fallback = fallback;
    this.lastUsedProviderName = this.provider.name;
  }

  setProvider(provider: DesignAdvisorProvider, fallback?: DesignAdvisorProvider) {
    this.provider = provider;
    this.fallback = fallback;
  }

  /** Name of the provider that produced the most recent answer. */
  getLastUsedProviderName(): string {
    return this.lastUsedProviderName;
  }

  async ask(context: DesignQueryContext): Promise<DesignAdviceResponse> {
    if (!this.fallback) {
      this.lastUsedProviderName = this.provider.name;
      return this.provider.generateAdvice(context);
    }
    try {
      this.lastUsedProviderName = this.provider.name;
      return await this.provider.generateAdvice(context);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.lastUsedProviderName = this.fallback.name;
      const advice = await this.fallback.generateAdvice(context);
      advice.disclaimers = [
        `Model backend unavailable; answered by offline heuristics. (${reason})`,
        ...advice.disclaimers
      ];
      return advice;
    }
  }
}
