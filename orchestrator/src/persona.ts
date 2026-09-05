const CHAT_COMPLETIONS_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

type Fetch = typeof fetch;

export type PersonaDraft = {
  displayName: string;
  summary: string;
  interests: string[];
  values: string[];
  socialStyle: string;
};

type ExtractedPersona = Omit<PersonaDraft, 'displayName'>;

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

const personaSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    interests: { type: 'array', items: { type: 'string' } },
    values: { type: 'array', items: { type: 'string' } },
    socialStyle: { type: 'string' },
  },
  required: ['summary', 'interests', 'values', 'socialStyle'],
  additionalProperties: false,
} as const;

export class PersonaExtractionError extends Error {
  constructor(
    message: string,
    readonly status = 502
  ) {
    super(message);
    this.name = 'PersonaExtractionError';
  }
}

function cleanText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PersonaExtractionError(`Model returned an invalid ${field}`);
  }
  return value.trim().slice(0, maxLength);
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  )].slice(0, 8);
}

export async function extractPersona(
  transcript: string,
  displayName: string,
  apiKey: string,
  fetchImpl: Fetch = fetch
): Promise<PersonaDraft> {
  const cleanTranscript = transcript.trim();
  const cleanDisplayName = displayName.trim();

  if (cleanDisplayName.length === 0 || cleanDisplayName.length > 80) {
    throw new PersonaExtractionError('Display name must be 1–80 characters', 400);
  }
  if (cleanTranscript.length < 10 || cleanTranscript.length > 8_000) {
    throw new PersonaExtractionError(
      'Transcript must be between 10 and 8,000 characters',
      400
    );
  }

  const response = await fetchImpl(CHAT_COMPLETIONS_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-5.6-luna',
      messages: [
        {
          role: 'system',
          content:
            'Extract a concise social persona from the interview transcript. ' +
            'Use only information the person stated or directly implied. ' +
            'Do not diagnose, infer sensitive traits, or claim scientific certainty. ' +
            'Keep the summary to two sentences and each list to at most eight short items.',
        },
        { role: 'user', content: cleanTranscript },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'persona_draft',
          strict: true,
          schema: personaSchema,
        },
      },
      max_completion_tokens: 4_000,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new PersonaExtractionError(
      `Persona extraction failed with status ${response.status}`
    );
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new PersonaExtractionError('Model returned no persona');
  }

  let extracted: Partial<ExtractedPersona>;
  try {
    extracted = JSON.parse(content) as Partial<ExtractedPersona>;
  } catch {
    throw new PersonaExtractionError('Model returned invalid persona JSON');
  }

  return {
    displayName: cleanDisplayName,
    summary: cleanText(extracted.summary, 'summary', 400),
    interests: cleanList(extracted.interests),
    values: cleanList(extracted.values),
    socialStyle: cleanText(extracted.socialStyle, 'social style', 200),
  };
}
