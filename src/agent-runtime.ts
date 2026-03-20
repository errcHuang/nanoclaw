import { ChildProcess } from 'child_process';

import { MAIN_GROUP_FOLDER } from './config.js';
import {
  AvailableGroup,
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { getAllChats, getAllTasks, setSession } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface ExecuteAgentRunOptions {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  registeredGroups: Record<string, RegisteredGroup>;
  sessions?: Record<string, string>;
  persistSession?: boolean;
  onProcess?: (
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  onOutput?: (output: ContainerOutput) => Promise<void>;
}

export function listAvailableGroups(
  registeredGroups: Record<string, RegisteredGroup>,
): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

export function findRegisteredGroupByFolder(
  registeredGroups: Record<string, RegisteredGroup>,
  folder: string,
): { chatJid: string; group: RegisteredGroup } | undefined {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (group.folder === folder) {
      return { chatJid, group };
    }
  }
  return undefined;
}

export function getDisplayText(result: string | null): string {
  if (!result) return '';
  return result.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export async function executeAgentRun(
  options: ExecuteAgentRunOptions,
): Promise<'success' | 'error'> {
  const {
    group,
    prompt,
    chatJid,
    registeredGroups,
    sessions,
    persistSession = true,
    onProcess,
    onOutput,
  } = options;

  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = persistSession ? sessions?.[group.folder] : undefined;

  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  writeGroupsSnapshot(
    group.folder,
    isMain,
    listAvailableGroups(registeredGroups),
    new Set(Object.keys(registeredGroups)),
  );

  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (persistSession && output.newSessionId && sessions) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => onProcess?.(proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (persistSession && output.newSessionId && sessions) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}
