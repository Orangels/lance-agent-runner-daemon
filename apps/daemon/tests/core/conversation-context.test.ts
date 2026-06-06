import { describe, expect, it } from 'vitest';
import { buildConversationPromptContext } from '../../src/core/conversation-context.js';

describe('conversation context builder', () => {
  it('keeps recent messages, truncates long messages, and reports generic warnings', () => {
    const result = buildConversationPromptContext(
      [
        { role: 'user', content: 'old request' },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'A'.repeat(10) },
        { role: 'assistant', content: 'fresh answer' },
      ],
      {
        recentMessages: 3,
        maxMessageChars: 5,
        maxTotalChars: 50,
      },
    );

    expect(result.messages).toEqual([
      { role: 'assistant', content: 'old a...' },
      { role: 'user', content: 'AAAAA...' },
      { role: 'assistant', content: 'fresh...' },
    ]);
    expect(result.warnings).toEqual([
      '1 older conversation message omitted by contextPolicy.recentMessages.',
      '3 conversation messages truncated by contextPolicy.maxMessageChars.',
    ]);
  });

  it('drops oldest messages when the total context budget is exceeded', () => {
    const result = buildConversationPromptContext(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
      ],
      {
        recentMessages: 10,
        maxMessageChars: 100,
        maxTotalChars: 11,
      },
    );

    expect(result.messages).toEqual([
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);
    expect(result.warnings).toEqual([
      '1 older conversation message omitted by contextPolicy.maxTotalChars.',
    ]);
  });

  it('can suppress warnings while still applying limits', () => {
    const result = buildConversationPromptContext(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ],
      {
        recentMessages: 1,
        includeRunWarnings: false,
      },
    );

    expect(result.messages).toEqual([{ role: 'assistant', content: 'second' }]);
    expect(result.warnings).toEqual([]);
  });
});
