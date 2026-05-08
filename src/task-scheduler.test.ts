import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup, ScheduledTask } from './types.js';

const {
  mockRunContainerAgent,
  mockWriteTasksSnapshot,
  mockGetAllTasks,
  mockGetDueTasks,
  mockGetTaskById,
  mockLogTaskRun,
  mockUpdateTaskAfterRun,
} = vi.hoisted(() => ({
  mockRunContainerAgent: vi.fn(),
  mockWriteTasksSnapshot: vi.fn(),
  mockGetAllTasks: vi.fn(),
  mockGetDueTasks: vi.fn(),
  mockGetTaskById: vi.fn(),
  mockLogTaskRun: vi.fn(),
  mockUpdateTaskAfterRun: vi.fn(),
}));

vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 30_000,
  MAIN_GROUP_FOLDER: 'main',
  SCHEDULER_POLL_INTERVAL: 1_000,
  TIMEZONE: 'UTC',
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: mockRunContainerAgent,
  writeTasksSnapshot: mockWriteTasksSnapshot,
}));

vi.mock('./db.js', () => ({
  getAllTasks: mockGetAllTasks,
  getDueTasks: mockGetDueTasks,
  getTaskById: mockGetTaskById,
  logTaskRun: mockLogTaskRun,
  updateTaskAfterRun: mockUpdateTaskAfterRun,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const group: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: '2026-03-10T00:00:00.000Z',
};

const baseTask: ScheduledTask = {
  id: 'task-1',
  group_folder: 'test-group',
  chat_jid: 'test@g.us',
  prompt: 'Send the daily reminder.',
  model: null,
  schedule_type: 'once',
  schedule_value: '2026-03-10T09:00:00.000Z',
  context_mode: 'isolated',
  next_run: '2026-03-10T09:00:00.000Z',
  last_run: null,
  last_result: null,
  status: 'active',
  created_at: '2026-03-10T08:00:00.000Z',
};

describe('task-scheduler', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });
    mockGetAllTasks.mockReturnValue([baseTask]);
    mockGetTaskById.mockReturnValue(baseTask);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not re-enqueue a due task while its current run is still in flight', async () => {
    mockGetDueTasks.mockReturnValue([baseTask]);

    const queuedFns: Array<() => Promise<void>> = [];
    const queue = {
      enqueueTask: vi.fn(
        (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          queuedFns.push(fn);
        },
      ),
      closeStdin: vi.fn(),
    };
    const sendMessage = vi.fn(async () => {});

    const { startSchedulerLoop } = await import('./task-scheduler.js');
    startSchedulerLoop({
      registeredGroups: () => ({ [baseTask.chat_jid]: group }),
      getSessions: () => ({}),
      queue: queue as any,
      onProcess: () => {},
      sendMessage,
    });

    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(queuedFns).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);

    await queuedFns[0]();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(queue.enqueueTask).toHaveBeenCalledTimes(2);
  });

  it('suppresses duplicate consecutive streamed results within a single task run', async () => {
    mockGetDueTasks.mockReturnValueOnce([baseTask]).mockReturnValue([]);
    mockRunContainerAgent.mockImplementation(
      async (
        _group: RegisteredGroup,
        _input: unknown,
        _onProcess: unknown,
        onOutput?: (output: { status: 'success' | 'error'; result: string | null }) => Promise<void>,
      ) => {
        if (onOutput) {
          await onOutput({ status: 'success', result: 'Daily summary' });
          await onOutput({ status: 'success', result: 'Daily summary' });
        }
        return { status: 'success', result: null };
      },
    );

    const queuedFns: Array<() => Promise<void>> = [];
    const queue = {
      enqueueTask: vi.fn(
        (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          queuedFns.push(fn);
        },
      ),
      closeStdin: vi.fn(),
    };
    const sendMessage = vi.fn(async () => {});

    const { startSchedulerLoop } = await import('./task-scheduler.js');
    startSchedulerLoop({
      registeredGroups: () => ({ [baseTask.chat_jid]: group }),
      getSessions: () => ({}),
      queue: queue as any,
      onProcess: () => {},
      sendMessage,
    });

    expect(queuedFns).toHaveLength(1);

    await queuedFns[0]();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(baseTask.chat_jid, 'Daily summary');
    expect(mockUpdateTaskAfterRun).toHaveBeenCalledWith(
      baseTask.id,
      null,
      'Daily summary',
    );
  });

  it('does not send or save internal-only streamed task output', async () => {
    mockGetDueTasks.mockReturnValueOnce([baseTask]).mockReturnValue([]);
    mockRunContainerAgent.mockImplementation(
      async (
        _group: RegisteredGroup,
        _input: unknown,
        _onProcess: unknown,
        onOutput?: (output: { status: 'success' | 'error'; result: string | null }) => Promise<void>,
      ) => {
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: '<internal>\nChecking email before sending the summary.\n</internal>',
          });
        }
        return { status: 'success', result: null };
      },
    );

    const queuedFns: Array<() => Promise<void>> = [];
    const queue = {
      enqueueTask: vi.fn(
        (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          queuedFns.push(fn);
        },
      ),
      closeStdin: vi.fn(),
    };
    const sendMessage = vi.fn(async () => {});

    const { startSchedulerLoop } = await import('./task-scheduler.js');
    startSchedulerLoop({
      registeredGroups: () => ({ [baseTask.chat_jid]: group }),
      getSessions: () => ({}),
      queue: queue as any,
      onProcess: () => {},
      sendMessage,
    });

    expect(queuedFns).toHaveLength(1);

    await queuedFns[0]();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(mockUpdateTaskAfterRun).toHaveBeenCalledWith(
      baseTask.id,
      null,
      'Completed',
    );
  });

  it('runs isolated tasks without resuming a group session', async () => {
    const isolatedTask = { ...baseTask, context_mode: 'isolated' as const };
    mockGetDueTasks.mockReturnValueOnce([isolatedTask]).mockReturnValue([]);
    mockGetTaskById.mockReturnValueOnce(isolatedTask);

    const queuedFns: Array<() => Promise<void>> = [];
    const queue = {
      enqueueTask: vi.fn(
        (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          queuedFns.push(fn);
        },
      ),
      closeStdin: vi.fn(),
    };

    const { startSchedulerLoop } = await import('./task-scheduler.js');
    startSchedulerLoop({
      registeredGroups: () => ({ [baseTask.chat_jid]: group }),
      getSessions: () => ({ [baseTask.group_folder]: 'session-123' }),
      queue: queue as any,
      onProcess: () => {},
      sendMessage: vi.fn(async () => {}),
    });

    expect(queuedFns).toHaveLength(1);

    await queuedFns[0]();

    expect(mockRunContainerAgent).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        prompt: baseTask.prompt,
        model: undefined,
        sessionId: undefined,
        groupFolder: baseTask.group_folder,
        chatJid: baseTask.chat_jid,
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('runs snapshot tasks without resuming a group session', async () => {
    const snapshotTask = {
      ...baseTask,
      context_mode: 'snapshot' as const,
      prompt: 'snapshot prompt',
    };
    mockGetDueTasks.mockReturnValueOnce([snapshotTask]).mockReturnValue([]);
    mockGetTaskById.mockReturnValueOnce(snapshotTask);

    const queuedFns: Array<() => Promise<void>> = [];
    const queue = {
      enqueueTask: vi.fn(
        (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          queuedFns.push(fn);
        },
      ),
      closeStdin: vi.fn(),
    };

    const { startSchedulerLoop } = await import('./task-scheduler.js');
    startSchedulerLoop({
      registeredGroups: () => ({ [baseTask.chat_jid]: group }),
      getSessions: () => ({ [baseTask.group_folder]: 'session-123' }),
      queue: queue as any,
      onProcess: () => {},
      sendMessage: vi.fn(async () => {}),
    });

    expect(queuedFns).toHaveLength(1);

    await queuedFns[0]();

    expect(mockRunContainerAgent).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        prompt: 'snapshot prompt',
        sessionId: undefined,
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('runs explicit group-mode tasks with the saved group session', async () => {
    const groupTask = { ...baseTask, context_mode: 'group' as const };
    mockGetDueTasks.mockReturnValueOnce([groupTask]).mockReturnValue([]);
    mockGetTaskById.mockReturnValueOnce(groupTask);

    const queuedFns: Array<() => Promise<void>> = [];
    const queue = {
      enqueueTask: vi.fn(
        (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          queuedFns.push(fn);
        },
      ),
      closeStdin: vi.fn(),
    };

    const { startSchedulerLoop } = await import('./task-scheduler.js');
    startSchedulerLoop({
      registeredGroups: () => ({ [baseTask.chat_jid]: group }),
      getSessions: () => ({ [baseTask.group_folder]: 'session-123' }),
      queue: queue as any,
      onProcess: () => {},
      sendMessage: vi.fn(async () => {}),
    });

    expect(queuedFns).toHaveLength(1);

    await queuedFns[0]();

    expect(mockRunContainerAgent).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        prompt: baseTask.prompt,
        model: undefined,
        sessionId: 'session-123',
        groupFolder: baseTask.group_folder,
        chatJid: baseTask.chat_jid,
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('passes through an explicit scheduled task model override', async () => {
    const modeledTask = {
      ...baseTask,
      model: 'claude-opus-4-6',
    };
    mockGetDueTasks.mockReturnValueOnce([modeledTask]).mockReturnValue([]);
    mockGetTaskById.mockReturnValueOnce(modeledTask);

    const queuedFns: Array<() => Promise<void>> = [];
    const queue = {
      enqueueTask: vi.fn(
        (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          queuedFns.push(fn);
        },
      ),
      closeStdin: vi.fn(),
    };

    const { startSchedulerLoop } = await import('./task-scheduler.js');
    startSchedulerLoop({
      registeredGroups: () => ({ [baseTask.chat_jid]: group }),
      getSessions: () => ({}),
      queue: queue as any,
      onProcess: () => {},
      sendMessage: vi.fn(async () => {}),
    });

    expect(queuedFns).toHaveLength(1);

    await queuedFns[0]();

    expect(mockRunContainerAgent).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        model: 'claude-opus-4-6',
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });
});
