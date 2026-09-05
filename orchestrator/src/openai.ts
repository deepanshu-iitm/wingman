const CHAT_COMPLETIONS_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export type FetchLike = typeof fetch;

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown };
  }>;
};

export class StructuredCompletionError extends Error {
  constructor(
    message: string,
    readonly status = 502
  ) {
    super(message);
    this.name = 'StructuredCompletionError';
  }
}

export async function requestStructuredJson<T>({
  apiKey,
  schemaName,
  schema,
  messages,
  fetchImpl = fetch,
  maxCompletionTokens = 4_000,
}: {
  apiKey: string;
  schemaName: string;
  schema: object;
  messages: ChatMessage[];
  fetchImpl?: FetchLike;
  maxCompletionTokens?: number;
}): Promise<T> {
  const response = await fetchImpl(CHAT_COMPLETIONS_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-5-nano',
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          strict: true,
          schema,
        },
      },
      max_completion_tokens: maxCompletionTokens,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new StructuredCompletionError(
      `OpenAI request failed with status ${response.status}`,
      response.status
    );
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    const suffix =
      choice?.finish_reason === 'length'
        ? ' because the completion token limit was reached'
        : '';
    throw new StructuredCompletionError(`Model returned no structured output${suffix}`);
  }

  try {
    return JSON.parse(content) as T;
  } catch {
    throw new StructuredCompletionError('Model returned invalid JSON');
  }
}
