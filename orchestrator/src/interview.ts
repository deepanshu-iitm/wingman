import {
  requestStructuredJson,
  StructuredCompletionError,
  type FetchLike,
} from './openai.js';

export const MAX_INTERVIEW_ANSWERS = 5;
export const MIN_INTERVIEW_ANSWERS = 3;

export const INTERVIEW_DIMENSIONS = [
  'social_energy',
  'openness',
  'planning_style',
  'communication_style',
  'personal_values',
  'friendship_expectations',
] as const;

export type InterviewDimension = (typeof INTERVIEW_DIMENSIONS)[number];

export type InterviewTurn = {
  role: 'assistant' | 'user';
  content: string;
};

export type InterviewStep = {
  reply: string;
  question: string;
  coveredDimensions: InterviewDimension[];
  readyToFinalize: boolean;
};

const interviewStepSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    question: { type: 'string' },
    coveredDimensions: {
      type: 'array',
      items: { type: 'string', enum: INTERVIEW_DIMENSIONS },
    },
    readyToFinalize: { type: 'boolean' },
  },
  required: [
    'reply',
    'question',
    'coveredDimensions',
    'readyToFinalize',
  ],
  additionalProperties: false,
} as const;

export class InterviewGenerationError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'InterviewGenerationError';
  }
}

const fallbackQuestions: Record<InterviewDimension, string> = {
  social_energy:
    'After a busy week, would you rather recharge alone, with one close friend, or in a lively group?',
  openness:
    'When a friend suggests something completely new, what usually makes you say yes or no?',
  planning_style:
    'What feels better with friends: a clear plan or deciding together in the moment?',
  communication_style:
    'If something feels off with a friend, how do you prefer to handle it?',
  personal_values:
    'What quality makes you trust and respect someone most?',
  friendship_expectations:
    'What would make a new friendship feel genuinely worthwhile to you?',
};

export function fallbackInterviewStep(
  coveredDimensions: InterviewDimension[],
): InterviewStep {
  const nextDimension =
    INTERVIEW_DIMENSIONS.find(
      (dimension) => !coveredDimensions.includes(dimension),
    ) ?? 'friendship_expectations';
  return {
    reply: 'That gives me a clearer picture of what matters to you.',
    question: fallbackQuestions[nextDimension],
    coveredDimensions: [...new Set([...coveredDimensions, nextDimension])],
    readyToFinalize: false,
  };
}

export async function generateInterviewStep(
  turns: InterviewTurn[],
  coveredDimensions: InterviewDimension[],
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<InterviewStep> {
  const userAnswerCount = turns.filter((turn) => turn.role === 'user').length;
  if (userAnswerCount === 0) {
    throw new InterviewGenerationError('At least one user answer is required', 400);
  }

  const safeTurns = turns.slice(-10).map((turn) => ({
    role: turn.role,
    content: turn.content.trim().slice(0, 1_200),
  }));
  if (safeTurns.some((turn) => !turn.content)) {
    throw new InterviewGenerationError('Interview contains an empty turn', 400);
  }

  let parsed: InterviewStep;
  try {
    parsed = await requestStructuredJson<InterviewStep>({
      apiKey,
      schemaName: 'adaptive_interview_step',
      schema: interviewStepSchema,
      fetchImpl,
      maxCompletionTokens: 1_500,
      messages: [
        {
          role: 'system',
          content:
            'You are Wingman conducting a brief, warm friendship-fit interview. ' +
            'Acknowledge the user specifically, then ask exactly one natural follow-up ' +
            'based on their latest answer and an uncovered dimension. The dimensions are: ' +
            `${INTERVIEW_DIMENSIONS.join(', ')}. Use them as coverage guidance, not as a ` +
            'clinical test. Never diagnose, infer sensitive traits, or ask about trauma, ' +
            'health, religion, politics, sexuality, or protected characteristics unless the ' +
            'user voluntarily raised the topic; even then, do not probe it. Prefer concrete ' +
            'situations over rating-scale questions. Keep reply and question under 180 ' +
            'characters each. Mark readyToFinalize only after enough information is present ' +
            `and at least ${MIN_INTERVIEW_ANSWERS} user answers have been given.`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            answerCount: userAnswerCount,
            maximumAnswers: MAX_INTERVIEW_ANSWERS,
            alreadyCovered: coveredDimensions,
            conversation: safeTurns,
          }),
        },
      ],
    });
  } catch (error) {
    if (error instanceof StructuredCompletionError) {
      throw new InterviewGenerationError(error.message, error.status);
    }
    throw error;
  }

  const reply = parsed.reply.trim().slice(0, 180);
  const question = parsed.question.trim().slice(0, 180);
  if (!reply || !question) {
    throw new InterviewGenerationError('Model returned an incomplete interview step');
  }

  const covered = [
    ...new Set(
      parsed.coveredDimensions.filter((dimension) =>
        INTERVIEW_DIMENSIONS.includes(dimension),
      ),
    ),
  ];

  return {
    reply,
    question,
    coveredDimensions: covered,
    readyToFinalize:
      userAnswerCount >= MIN_INTERVIEW_ANSWERS && parsed.readyToFinalize,
  };
}
