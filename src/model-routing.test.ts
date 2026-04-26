import { describe, expect, it } from 'vitest';

import {
  inferClaudeModelFromPrompt,
  normalizeClaudeModel,
  stripClaudeModelDirectives,
} from './model-routing.js';

describe('model routing', () => {
  it('normalizes supported Claude model aliases', () => {
    expect(normalizeClaudeModel('haiku')).toBe('claude-haiku-4-5');
    expect(normalizeClaudeModel('sonnet')).toBe('claude-sonnet-4-6');
    expect(normalizeClaudeModel('opus')).toBe('claude-opus-4-6');
  });

  it('infers model directives from prompt text case-insensitively', () => {
    expect(inferClaudeModelFromPrompt('Please USE Haiku for this.')).toBe(
      'claude-haiku-4-5',
    );
    expect(inferClaudeModelFromPrompt('can you use sonnet here?')).toBe(
      'claude-sonnet-4-6',
    );
    expect(inferClaudeModelFromPrompt('use opus')).toBe('claude-opus-4-6');
  });

  it('uses the last model directive when multiple are present', () => {
    expect(inferClaudeModelFromPrompt('use haiku first, then use opus')).toBe(
      'claude-opus-4-6',
    );
  });

  it('returns null when no routing directive is present', () => {
    expect(inferClaudeModelFromPrompt('please answer normally')).toBeNull();
  });

  it('strips model directives from prompt text', () => {
    expect(stripClaudeModelDirectives('use opus summarize this')).toBe(
      'summarize this',
    );
    expect(stripClaudeModelDirectives('Please USE Sonnet for this')).toBe(
      'Please for this',
    );
  });
});
