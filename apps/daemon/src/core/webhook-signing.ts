import { createHmac } from 'node:crypto';

export function signWebhookPayload(input: {
  secret: string;
  timestamp: number;
  rawBody: string;
}): string {
  const signature = createHmac('sha256', input.secret)
    .update(`${input.timestamp}.${input.rawBody}`)
    .digest('hex');
  return `v1=${signature}`;
}
