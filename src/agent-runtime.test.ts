import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  MAIN_GROUP_FOLDER: 'main',
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getAllChats: vi.fn(() => [
    { jid: 'team@g.us', name: 'Team', last_message_time: '2026-03-20T00:00:00.000Z' },
  ]),
  getAllTasks: vi.fn(() => [
    {
      id: 'task-1',
      group_folder: 'main',
      prompt: 'Do a thing',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      status: 'active',
      next_run: '2026-03-20T01:00:00.000Z',
    },
  ]),
  setSession: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    error: vi.fn(),
  },
}));

import {
  executeAgentRun,
  findRegisteredGroupByFolder,
  getDisplayText,
  listAvailableGroups,
} from './agent-runtime.js';
import {
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { setSession } from './db.js';
import type { RegisteredGroup } from './types.js';

const registeredGroups: Record<string, RegisteredGroup> = {
  'main@s.whatsapp.net': {
    name: 'main',
    folder: 'main',
    trigger: '@Andy',
    added_at: '2026-03-20T00:00:00.000Z',
  },
};

describe('agent-runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finds groups by folder', () => {
    expect(findRegisteredGroupByFolder(registeredGroups, 'main')).toEqual({
      chatJid: 'main@s.whatsapp.net',
      group: registeredGroups['main@s.whatsapp.net'],
    });
    expect(findRegisteredGroupByFolder(registeredGroups, 'missing')).toBeUndefined();
  });

  it('lists available groups with registration state', () => {
    expect(listAvailableGroups(registeredGroups)).toEqual([
      {
        jid: 'team@g.us',
        name: 'Team',
        lastActivity: '2026-03-20T00:00:00.000Z',
        isRegistered: false,
      },
    ]);
  });

  it('strips internal tags from display text', () => {
    expect(getDisplayText('hi <internal>secret</internal> there')).toBe('hi  there');
  });

  it('persists sessions in persistent mode', async () => {
    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: 'done',
      newSessionId: 'session-1',
    });
    const sessions: Record<string, string> = {};

    const status = await executeAgentRun({
      group: registeredGroups['main@s.whatsapp.net'],
      prompt: 'hello',
      chatJid: 'main@s.whatsapp.net',
      registeredGroups,
      sessions,
    });

    expect(status).toBe('success');
    expect(sessions.main).toBe('session-1');
    expect(setSession).toHaveBeenCalledWith('main', 'session-1');
    expect(writeTasksSnapshot).toHaveBeenCalled();
    expect(writeGroupsSnapshot).toHaveBeenCalled();
  });

  it('does not persist sessions in stateless mode', async () => {
    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: 'done',
      newSessionId: 'session-2',
    });
    const sessions: Record<string, string> = {};

    const status = await executeAgentRun({
      group: registeredGroups['main@s.whatsapp.net'],
      prompt: 'hello',
      chatJid: 'main@s.whatsapp.net',
      registeredGroups,
      sessions,
      persistSession: false,
    });

    expect(status).toBe('success');
    expect(sessions.main).toBeUndefined();
    expect(setSession).not.toHaveBeenCalled();
  });
});
