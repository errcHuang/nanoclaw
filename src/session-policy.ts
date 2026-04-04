import { NewMessage } from './types.js';

const CLEAR_COMMAND_RE = /^\/clear\b([\s\S]*)$/i;

export interface ClearResolution {
  clearRequested: boolean;
  clearTimestamp?: string;
  messages: NewMessage[];
}

function extractClearRemainder(content: string): string | null {
  const match = content.trim().match(CLEAR_COMMAND_RE);
  if (!match) return null;
  return match[1].trim();
}

export function hasClearCommand(messages: NewMessage[]): boolean {
  return messages.some((message) => extractClearRemainder(message.content) !== null);
}

export function applyClearCommand(messages: NewMessage[]): ClearResolution {
  let clearIndex = -1;
  let clearRemainder = '';

  for (let i = 0; i < messages.length; i++) {
    const remainder = extractClearRemainder(messages[i].content);
    if (remainder === null) continue;
    clearIndex = i;
    clearRemainder = remainder;
  }

  if (clearIndex === -1) {
    return { clearRequested: false, messages };
  }

  const clearMessage = messages[clearIndex];
  const afterClear = messages.slice(clearIndex + 1);
  const normalized: NewMessage[] = [];

  if (clearRemainder) {
    normalized.push({
      ...clearMessage,
      id: `${clearMessage.id}::clear-followup`,
      content: clearRemainder,
    });
  }

  normalized.push(...afterClear);

  return {
    clearRequested: true,
    clearTimestamp: clearMessage.timestamp,
    messages: normalized,
  };
}

export function isTimestampOutsideWindow(
  timestamp: string | undefined,
  windowMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!timestamp || windowMs <= 0) return false;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return false;
  return nowMs - parsed > windowMs;
}
