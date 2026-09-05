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
