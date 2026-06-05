import type { ConversationPromptMessage } from './prompt-composer.js';
import type { ContextPolicy } from './run-types.js';

export interface NormalizedContextPolicy {
  recentMessages: number;
  maxMessageChars: number;
  maxTotalChars: number;
  includeRunWarnings: boolean;
}

export interface ConversationPromptContext {
  messages: ConversationPromptMessage[];
  warnings: string[];
  policy: NormalizedContextPolicy;
}

const defaultContextPolicy: NormalizedContextPolicy = {
  recentMessages: 20,
  maxMessageChars: 4_000,
  maxTotalChars: 20_000,
  includeRunWarnings: true,
};

export function normalizeContextPolicy(policy: ContextPolicy | null | undefined): NormalizedContextPolicy {
  return {
    recentMessages: policy?.recentMessages ?? defaultContextPolicy.recentMessages,
    maxMessageChars: policy?.maxMessageChars ?? defaultContextPolicy.maxMessageChars,
    maxTotalChars: policy?.maxTotalChars ?? defaultContextPolicy.maxTotalChars,
    includeRunWarnings: policy?.includeRunWarnings ?? defaultContextPolicy.includeRunWarnings,
  };
}

export function buildConversationPromptContext(
  messages: ConversationPromptMessage[],
  policyInput?: ContextPolicy | null,
): ConversationPromptContext {
  const policy = normalizeContextPolicy(policyInput);
  const warnings: string[] = [];
  const recentMessages = policy.recentMessages === 0 ? [] : messages.slice(-policy.recentMessages);
  const omittedByRecentMessages = messages.length - recentMessages.length;
  if (omittedByRecentMessages > 0) {
    warnings.push(
      `${omittedByRecentMessages} older conversation ${pluralize(
        'message',
        omittedByRecentMessages,
      )} omitted by contextPolicy.recentMessages.`,
    );
  }

  let truncatedMessages = 0;
  const limitedMessages = recentMessages.map((message) => {
    if (message.content.length <= policy.maxMessageChars) {
      return message;
    }
    truncatedMessages += 1;
    return {
      ...message,
      content: `${message.content.slice(0, policy.maxMessageChars)}...`,
    };
  });
  if (truncatedMessages > 0) {
    warnings.push(
      `${truncatedMessages} conversation ${pluralize(
        'message',
        truncatedMessages,
      )} truncated by contextPolicy.maxMessageChars.`,
    );
  }

  const cappedMessages = keepNewestWithinTotal(limitedMessages, policy.maxTotalChars);
  const omittedByTotalChars = limitedMessages.length - cappedMessages.length;
  if (omittedByTotalChars > 0) {
    warnings.push(
      `${omittedByTotalChars} older conversation ${pluralize(
        'message',
        omittedByTotalChars,
      )} omitted by contextPolicy.maxTotalChars.`,
    );
  }

  return {
    messages: cappedMessages,
    warnings: policy.includeRunWarnings ? warnings : [],
    policy,
  };
}

function keepNewestWithinTotal(
  messages: ConversationPromptMessage[],
  maxTotalChars: number,
): ConversationPromptMessage[] {
  const kept: ConversationPromptMessage[] = [];
  let totalChars = 0;

  for (const message of [...messages].reverse()) {
    const nextTotal = totalChars + message.content.length;
    if (kept.length > 0 && nextTotal > maxTotalChars) {
      break;
    }
    kept.push(message);
    totalChars = nextTotal;
  }

  return kept.reverse();
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}
