import type { HistoryStore } from '../store/store';
import type { RenderCache } from '../preview/cache';
import type { Checkpoint } from '../bridge/timeline';
import type { ChatMessage, ChatbotState, DesignAdviceResponse } from './types';
import { assembleChatbotContext } from './context';
import { DesignAdvisorService } from './advisor';

export class ChatbotController {
  private messages: ChatMessage[] = [];
  private advisorService: DesignAdvisorService;
  private busy = false;

  constructor(
    private readonly store: HistoryStore,
    private readonly getCache: () => RenderCache | undefined,
    private readonly getSecrets: () => Promise<readonly string[]>,
    private readonly notifyState: (state: ChatbotState) => void,
    advisorService: DesignAdvisorService,
    private readonly getLocks?: () => readonly {
      selector: string;
      document: string;
      label?: string;
    }[]
  ) {
    this.advisorService = advisorService;
  }

  getState(): ChatbotState {
    return {
      messages: [...this.messages],
      busy: this.busy,
      activeCheckpointId: this.store.checkpoints.filter((c) => !c.branch).at(-1)?.id
    };
  }

  clearHistory() {
    this.messages = [];
    this.notifyState(this.getState());
  }

  async handleQuery(
    userQuery: string,
    checkpointId?: string,
    compareCheckpointId?: string
  ): Promise<DesignAdviceResponse> {
    if (!userQuery.trim()) {
      throw new Error('Query cannot be empty.');
    }

    const checkpoints = this.store.checkpoints;
    if (!checkpoints.length) {
      throw new Error(
        'No checkpoints recorded yet. Capture or save files before consulting the UI advisor.'
      );
    }

    const activeCp: Checkpoint =
      (checkpointId ? checkpoints.find((c) => c.id === checkpointId) : undefined) ??
      checkpoints.filter((c) => !c.branch).at(-1) ??
      checkpoints[0];

    const compareCp: Checkpoint | undefined = compareCheckpointId
      ? checkpoints.find((c) => c.id === compareCheckpointId)
      : activeCp.parentId
        ? checkpoints.find((c) => c.id === activeCp.parentId)
        : undefined;

    const userMessage: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      sender: 'user',
      timestamp: new Date().toISOString(),
      text: userQuery
    };
    this.messages.push(userMessage);

    this.busy = true;
    this.notifyState(this.getState());

    try {
      const secrets = await this.getSecrets();
      const context = await assembleChatbotContext(this.store, activeCp, userQuery, {
        compareCheckpoint: compareCp,
        cache: this.getCache(),
        secrets,
        locks: this.getLocks?.()
      });

      const advice = await this.advisorService.ask(context);

      const advisorMessage: ChatMessage = {
        id: `msg-adv-${Date.now()}`,
        sender: 'advisor',
        timestamp: new Date().toISOString(),
        text: advice.directAnswer,
        advice
      };
      this.messages.push(advisorMessage);

      this.busy = false;
      this.notifyState(this.getState());
      return advice;
    } catch (error) {
      this.busy = false;
      const errorMsg = error instanceof Error ? error.message : 'Failed to analyze UI.';
      this.notifyState({
        ...this.getState(),
        error: errorMsg
      });
      throw error;
    }
  }
}
