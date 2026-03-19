import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import { spawn } from 'child_process';
import { readEnvFile } from './env.js';
import { validateAdditionalMounts } from './mount-security.js';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock env loader
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    }),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('passes allowed secrets from .env via stdin input', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      OPEN_BRAIN_KEY: 'brain-key',
    });

    let stdinPayload = '';
    fakeProc.stdin.on('data', (chunk) => {
      stdinPayload += chunk.toString();
    });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const parsed = JSON.parse(stdinPayload);
    expect(readEnvFile).toHaveBeenCalledWith([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'OPEN_BRAIN_KEY',
    ]);
    expect(parsed.secrets.OPEN_BRAIN_KEY).toBe('brain-key');
  });

  it('mounts ~/.config/gws into main group containers when present', async () => {
    const home = process.env.HOME || '/tmp';
    const gwsConfigDir = `${home}/.config/gws`;
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === gwsConfigDir,
    );

    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput, isMain: true },
      () => {},
      async () => {},
    );

    const mockedSpawn = vi.mocked(spawn);
    const spawnArgs = mockedSpawn.mock.calls.at(-1)?.[1] as string[];
    expect(
      spawnArgs.some((a) => a.includes(`${gwsConfigDir}:/workspace/gws`)),
    ).toBe(true);
    expect(spawnArgs).toContain('GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/workspace/gws');
    expect(spawnArgs).toContain(
      'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/workspace/gws/credentials.json',
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('mounts ~/obsidian-vault into every container when present', async () => {
    const home = process.env.HOME || '/tmp';
    const obsidianVaultDir = `${home}/obsidian-vault`;
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === obsidianVaultDir,
    );

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    const mockedSpawn = vi.mocked(spawn);
    const spawnArgs = mockedSpawn.mock.calls.at(-1)?.[1] as string[];
    expect(
      spawnArgs.some((a) => a.includes(`${obsidianVaultDir}:/workspace/extra/obsidian`)),
    ).toBe(true);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('skips duplicate obsidian mounts when a group already mounts /workspace/extra/obsidian', async () => {
    const home = process.env.HOME || '/tmp';
    const obsidianVaultDir = `${home}/obsidian-vault`;
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === obsidianVaultDir,
    );
    vi.mocked(validateAdditionalMounts).mockReturnValue([
      {
        hostPath: '/custom/obsidian',
        containerPath: '/workspace/extra/obsidian',
        readonly: false,
      },
    ]);

    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        containerConfig: {
          additionalMounts: [
            {
              hostPath: '~/obsidian-vault',
              containerPath: 'obsidian',
              readonly: false,
            },
          ],
        },
      },
      testInput,
      () => {},
      async () => {},
    );

    const mockedSpawn = vi.mocked(spawn);
    const spawnArgs = mockedSpawn.mock.calls.at(-1)?.[1] as string[];
    const obsidianMountArgs = spawnArgs.filter((arg) =>
      arg.includes(':/workspace/extra/obsidian'),
    );
    expect(obsidianMountArgs).toHaveLength(1);
    expect(obsidianMountArgs[0]).toContain(`${obsidianVaultDir}:/workspace/extra/obsidian`);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});
