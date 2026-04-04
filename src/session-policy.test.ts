import { describe, expect, it } from 'vitest';

import { applyClearCommand, hasClearCommand, isTimestampOutsideWindow } from './session-policy.js';
import type { NewMessage } from './types.js';

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@g.us',
    sender: 'alice@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2026-04-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('session-policy', () => {
  it('detects clear commands', () => {
    expect(hasClearCommand([makeMessage({ content: '/clear' })])).toBe(true);
    expect(hasClearCommand([makeMessage({ content: 'please clear this up' })])).toBe(false);
  });

  it('drops messages before the last clear command', () => {
    const result = applyClearCommand([
      makeMessage({ id: 'm1', content: 'old context', timestamp: '2026-04-03T00:00:00.000Z' }),
      makeMessage({ id: 'm2', content: '/clear', timestamp: '2026-04-03T00:05:00.000Z' }),
      makeMessage({ id: 'm3', content: 'new context', timestamp: '2026-04-03T00:06:00.000Z' }),
    ]);

    expect(result.clearRequested).toBe(true);
    expect(result.clearTimestamp).toBe('2026-04-03T00:05:00.000Z');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('new context');
  });

  it('turns /clear with trailing text into the first message of the new session', () => {
    const result = applyClearCommand([
      makeMessage({ id: 'm1', content: '/clear remind me what we decided', timestamp: '2026-04-03T00:05:00.000Z' }),
    ]);

    expect(result.clearRequested).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('remind me what we decided');
    expect(result.messages[0].id).toContain('clear-followup');
  });

  it('resets on the last clear command when multiple are present', () => {
    const result = applyClearCommand([
      makeMessage({ id: 'm1', content: '/clear first reset', timestamp: '2026-04-03T00:01:00.000Z' }),
      makeMessage({ id: 'm2', content: 'ignore this', timestamp: '2026-04-03T00:02:00.000Z' }),
      makeMessage({ id: 'm3', content: '/clear second reset', timestamp: '2026-04-03T00:03:00.000Z' }),
      makeMessage({ id: 'm4', content: 'fresh context', timestamp: '2026-04-03T00:04:00.000Z' }),
    ]);

    expect(result.clearTimestamp).toBe('2026-04-03T00:03:00.000Z');
    expect(result.messages.map((message) => message.content)).toEqual([
      'second reset',
      'fresh context',
    ]);
  });

  it('detects timestamps outside the continuity window', () => {
    const now = Date.parse('2026-04-03T01:00:00.000Z');
    expect(
      isTimestampOutsideWindow('2026-04-03T00:00:00.000Z', 60 * 60 * 1000, now),
    ).toBe(false);
    expect(
      isTimestampOutsideWindow('2026-04-02T23:59:59.000Z', 60 * 60 * 1000, now),
    ).toBe(true);
  });
});
