import type { ConversationPhase, TurnIntent } from '../../src/agent.js';

export type ConversationCompletionState = {
  status: string;
  controlMode: string;
};

export function shouldArchiveConversation(
  conversation: ConversationCompletionState | null | undefined,
): boolean {
  return (
    conversation?.status === 'complete' &&
    conversation.controlMode === 'agent'
  );
}

export function nextConversationPhase(
  historyLength: number,
  minimumTurns: number,
  maximumTurns: number,
  previousIntent: TurnIntent | undefined,
  softDeadlineHit: boolean,
): ConversationPhase {
  if (historyLength === 0) return 'opening';
  if (historyLength < minimumTurns) return 'flowing';

  if (
    previousIntent === 'closing' ||
    previousIntent === 'wrapping_up' ||
    softDeadlineHit ||
    historyLength >= maximumTurns - 2
  ) {
    return 'closing';
  }

  return 'flowing';
}

/**
 * A closing turn always receives one final reply from the other persona before
 * the conversation ends.
 */
export function shouldEndAfterTurn(
  previousIntent: TurnIntent | undefined,
  historyLength: number,
  minimumTurns: number,
): boolean {
  return previousIntent === 'closing' && historyLength >= minimumTurns;
}
