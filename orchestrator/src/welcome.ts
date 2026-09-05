import type { FetchLike } from './openai.js';

const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class WelcomeEmailError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'WelcomeEmailError';
  }
}

export function validateEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new WelcomeEmailError('A valid email address is required', 400);
  }
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new WelcomeEmailError('A valid email address is required', 400);
  }
  return email;
}

export async function sendWelcomeEmail(
  email: string,
  displayName: string,
  apiKey: string,
  from: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const recipient = validateEmail(email);
  const name = displayName.trim().slice(0, 80) || 'there';

  const response = await fetchImpl(RESEND_EMAIL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [recipient],
      subject: 'Your Wingman is ready',
      text:
        `Hey ${name}, your Wingman profile is ready. ` +
        'Your agent can now meet people and find the conversations worth joining.',
      html:
        `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#16130e">` +
        `<h1 style="font-size:28px">Your Wingman is ready.</h1>` +
        `<p>Hey ${escapeHtml(name)}, your profile is live.</p>` +
        `<p>Your agent can now meet people and find the conversations worth joining.</p>` +
        `<p><a href="https://wingman-six-mu.vercel.app">Open Wingman</a></p>` +
        `</div>`,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new WelcomeEmailError(
      `Welcome email failed with status ${response.status}`,
      response.status,
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
