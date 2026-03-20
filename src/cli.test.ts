import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => ''),
}));

vi.mock('./db.js', () => ({
  getAllRegisteredGroups: vi.fn(() => ({
    'main@s.whatsapp.net': {
      name: 'main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-03-20T00:00:00.000Z',
    },
  })),
  initDatabase: vi.fn(),
}));

vi.mock('./agent-runtime.js', () => ({
  executeAgentRun: vi.fn(),
  findRegisteredGroupByFolder: vi.fn((groups: Record<string, unknown>, folder: string) => {
    const entry = Object.entries(groups).find(([, group]) => (group as { folder: string }).folder === folder);
    if (!entry) return undefined;
    return {
      chatJid: entry[0],
      group: entry[1],
    };
  }),
  getDisplayText: vi.fn((value: string | null) => value || ''),
}));

import { executeAgentRun } from './agent-runtime.js';
import { execFileSync } from 'child_process';
import { parseCliArgs, runCli } from './cli.js';

describe('cli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses args with default group', () => {
    expect(parseCliArgs(['hello', 'world'])).toEqual({
      groupFolder: 'main',
      prompt: 'hello world',
    });
  });

  it('parses args with explicit group', () => {
    expect(parseCliArgs(['--group', 'main', 'hello'])).toEqual({
      groupFolder: 'main',
      prompt: 'hello',
    });
  });

  it('rejects missing prompt', () => {
    expect(() => parseCliArgs([])).toThrow(/Prompt is required/);
  });

  it('streams output and returns zero on success', async () => {
    vi.mocked(executeAgentRun).mockImplementation(async ({ onOutput }) => {
      await onOutput?.({ status: 'success', result: 'hello', newSessionId: 'ignored' });
      return 'success';
    });
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const code = await runCli(['hello'], { stdout, stderr });

    expect(code).toBe(0);
    expect(stdout.write).toHaveBeenCalledWith('hello\n');
    expect(stderr.write).not.toHaveBeenCalled();
    expect(executeAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        persistSession: false,
      }),
    );
  });

  it('returns non-zero when the group does not exist', async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const code = await runCli(['--group', 'missing', 'hello'], { stdout, stderr });

    expect(code).toBe(1);
    expect(stderr.write).toHaveBeenCalledWith(
      'Unknown group folder: missing. Register the group first or use --group main.\n',
    );
  });

  it('refuses to run when the target group already has an active container', async () => {
    vi.mocked(execFileSync).mockReturnValue('nanoclaw-main-123\n');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const code = await runCli(['hello'], { stdout, stderr });

    expect(code).toBe(1);
    expect(executeAgentRun).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledWith(
      'Group main already has an active NanoClaw container. Wait for it to finish before using the CLI.\n',
    );
  });
});
