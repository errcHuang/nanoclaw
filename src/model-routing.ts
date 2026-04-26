export type ClaudeModelAlias = 'haiku' | 'sonnet' | 'opus';

const CLAUDE_MODELS: Record<ClaudeModelAlias, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

const MODEL_DIRECTIVE_PATTERN = /\buse[\s,:-]+(haiku|sonnet|opus)\b/gi;

export function normalizeClaudeModel(model: string | undefined): string | null {
  if (!model) return null;

  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === 'haiku' || normalized === CLAUDE_MODELS.haiku) {
    return CLAUDE_MODELS.haiku;
  }
  if (normalized === 'sonnet' || normalized === CLAUDE_MODELS.sonnet) {
    return CLAUDE_MODELS.sonnet;
  }
  if (normalized === 'opus' || normalized === CLAUDE_MODELS.opus) {
    return CLAUDE_MODELS.opus;
  }

  return null;
}

export function inferClaudeModelFromPrompt(prompt: string): string | null {
  let match: RegExpExecArray | null;
  let selectedAlias: ClaudeModelAlias | null = null;

  MODEL_DIRECTIVE_PATTERN.lastIndex = 0;
  while ((match = MODEL_DIRECTIVE_PATTERN.exec(prompt)) !== null) {
    selectedAlias = match[1].toLowerCase() as ClaudeModelAlias;
  }

  return selectedAlias ? CLAUDE_MODELS[selectedAlias] : null;
}
