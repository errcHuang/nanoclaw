import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { AvailableGroup, writeTasksSnapshot } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getMessagesSince,
  getTaskById,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import {
  inferClaudeModelFromPrompt,
  normalizeClaudeModel,
  stripClaudeModelDirectives,
} from './model-routing.js';
import { formatMessages, formatOutbound } from './router.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

const SNAPSHOT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_MAX_MESSAGES = 50;
const SNAPSHOT_CONTEXT_START = '[SNAPSHOT CONTEXT]';
const SNAPSHOT_CONTEXT_END = '[/SNAPSHOT CONTEXT]';

function normalizeTaskTitle(title: string | undefined): string | null {
  if (!title) return null;
  const normalized = title.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized || null;
}

function stripSnapshotContext(prompt: string): string {
  const start = prompt.indexOf(SNAPSHOT_CONTEXT_START);
  if (start === -1) return prompt.trim();

  const end = prompt.indexOf(SNAPSHOT_CONTEXT_END, start);
  if (end === -1) return prompt.slice(0, start).trim();

  return `${prompt.slice(0, start)}${prompt.slice(end + SNAPSHOT_CONTEXT_END.length)}`.trim();
}

function normalizePromptForComparison(prompt: string): string {
  return stripSnapshotContext(prompt).replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeContextMode(
  contextMode: string | undefined,
): 'group' | 'isolated' | 'snapshot' {
  return contextMode === 'group' ||
    contextMode === 'isolated' ||
    contextMode === 'snapshot'
    ? contextMode
    : 'isolated';
}

function computeNextRun(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      throw new Error('Invalid interval');
    }
    return new Date(Date.now() + ms).toISOString();
  }

  const scheduled = new Date(scheduleValue);
  if (isNaN(scheduled.getTime())) {
    throw new Error('Invalid timestamp');
  }
  return scheduled.toISOString();
}

function buildStoredTaskPrompt(
  prompt: string,
  contextMode: 'group' | 'isolated' | 'snapshot',
  targetJid: string,
): string {
  return contextMode === 'snapshot'
    ? buildSnapshotPrompt(prompt, targetJid)
    : prompt;
}

function findDuplicateTask(params: {
  groupFolder: string;
  title?: string | null;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode: 'group' | 'isolated' | 'snapshot';
  model: string | null;
  excludeTaskId?: string;
}): ScheduledTask | undefined {
  const normalizedTitle = normalizeTaskTitle(params.title || undefined);
  const normalizedPrompt = normalizePromptForComparison(params.prompt);

  return getAllTasks().find((task) =>
    task.id !== params.excludeTaskId &&
    task.group_folder === params.groupFolder &&
    task.status !== 'completed' &&
    (
      (normalizedTitle && normalizeTaskTitle(task.title || undefined) === normalizedTitle) ||
      (
        !normalizedTitle &&
        task.schedule_type === params.scheduleType &&
        task.schedule_value === params.scheduleValue &&
        task.context_mode === params.contextMode &&
        (task.model || null) === params.model &&
        normalizePromptForComparison(task.prompt) === normalizedPrompt
      )
    ),
  );
}

function refreshTaskSnapshots(deps: IpcDeps): void {
  const tasks = getAllTasks();
  const snapshot = tasks.map((task) => ({
    id: task.id,
    chatJid: task.chat_jid,
    groupFolder: task.group_folder,
    title: task.title,
    prompt: task.prompt,
    model: task.model,
    context_mode: task.context_mode,
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    status: task.status,
    next_run: task.next_run,
  }));

  const groupFolders = new Set<string>([MAIN_GROUP_FOLDER]);
  for (const group of Object.values(deps.registeredGroups())) {
    groupFolders.add(group.folder);
  }

  for (const groupFolder of groupFolders) {
    writeTasksSnapshot(
      groupFolder,
      groupFolder === MAIN_GROUP_FOLDER,
      snapshot,
    );
  }
}

function buildSnapshotPrompt(prompt: string, targetJid: string): string {
  const sinceTimestamp = new Date(Date.now() - SNAPSHOT_LOOKBACK_MS).toISOString();
  const recentMessages = getMessagesSince(
    targetJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  ).slice(-SNAPSHOT_MAX_MESSAGES);

  if (recentMessages.length === 0) {
    return prompt;
  }

  return `${prompt}

[SNAPSHOT CONTEXT]
The following is a bounded snapshot of recent non-bot chat context captured when this task was scheduled.
Use it as historical context only. Do not assume anything beyond this snapshot.

${formatMessages(recentMessages)}
[/SNAPSHOT CONTEXT]`;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const text = formatOutbound(data.text);
                  if (text) {
                    await deps.sendMessage(data.chatJid, text);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC message sent',
                    );
                  } else {
                    logger.debug(
                      { chatJid: data.chatJid, sourceGroup },
                      'Skipping internal-only IPC message',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    title?: string;
    model?: string;
    next_run?: string | null;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For request_pr
    requestId?: string;
    branch?: string;
    body?: string;
    issueNumber?: number;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';
        let nextRun: string | null = null;
        try {
          nextRun = computeNextRun(scheduleType, data.schedule_value);
        } catch (err) {
          logger.warn(
            { scheduleValue: data.schedule_value, error: err instanceof Error ? err.message : String(err) },
            'Invalid schedule for task',
          );
          break;
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode = normalizeContextMode(data.context_mode);
        const explicitTaskModel = normalizeClaudeModel(data.model);
        if (data.model && !explicitTaskModel) {
          logger.warn({ model: data.model }, 'Invalid task model');
          break;
        }
        const inferredTaskModel = inferClaudeModelFromPrompt(data.prompt);
        const taskModel = explicitTaskModel || inferredTaskModel;
        const basePrompt = taskModel
          ? stripClaudeModelDirectives(data.prompt)
          : data.prompt;
        const duplicateTask = findDuplicateTask({
          groupFolder: targetFolder,
          title: data.title || null,
          prompt: basePrompt,
          scheduleType,
          scheduleValue: data.schedule_value,
          contextMode,
          model: taskModel,
        });
        if (duplicateTask) {
          logger.info(
            { existingTaskId: duplicateTask.id, sourceGroup, targetFolder },
            'Duplicate scheduled task ignored via IPC',
          );
          break;
        }
        const taskPrompt = buildStoredTaskPrompt(basePrompt, contextMode, targetJid);

        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          title: data.title || null,
          prompt: taskPrompt,
          model: taskModel,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          {
            taskId,
            sourceGroup,
            targetFolder,
            model: taskModel || 'default',
            requestedContextMode: data.context_mode || 'unspecified',
            contextMode,
            snapshotMessages:
              contextMode === 'snapshot'
                ? Math.min(
                    SNAPSHOT_MAX_MESSAGES,
                    getMessagesSince(
                      targetJid,
                      new Date(Date.now() - SNAPSHOT_LOOKBACK_MS).toISOString(),
                      ASSISTANT_NAME,
                    ).length,
                  )
                : 0,
          },
          'Task created via IPC',
        );
        refreshTaskSnapshots(deps);
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task || (!isMain && task.group_folder !== sourceGroup)) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const scheduleType = (data.schedule_type || task.schedule_type) as 'cron' | 'interval' | 'once';
        const scheduleValue = data.schedule_value || task.schedule_value;
        const contextMode = normalizeContextMode(data.context_mode || task.context_mode);
        const explicitTaskModel = data.model !== undefined
          ? normalizeClaudeModel(data.model)
          : undefined;
        if (data.model !== undefined && data.model && !explicitTaskModel) {
          logger.warn({ model: data.model }, 'Invalid task model');
          break;
        }
        let nextRun: string | null;
        try {
          nextRun = data.next_run !== undefined
            ? data.next_run
            : computeNextRun(scheduleType, scheduleValue);
        } catch (err) {
          logger.warn(
            { taskId: data.taskId, scheduleValue, error: err instanceof Error ? err.message : String(err) },
            'Invalid schedule for task update',
          );
          break;
        }

        const rawBasePrompt = data.prompt || stripSnapshotContext(task.prompt);
        const promptInferredModel =
          data.prompt !== undefined ? inferClaudeModelFromPrompt(rawBasePrompt) : null;
        const basePrompt =
          data.prompt !== undefined && promptInferredModel
            ? stripClaudeModelDirectives(rawBasePrompt)
            : rawBasePrompt;
        const taskModel = data.model !== undefined
          ? (explicitTaskModel || null)
          : (data.prompt !== undefined
            ? promptInferredModel || (task.model || null)
            : (task.model || null));
        const duplicateTask = findDuplicateTask({
          groupFolder: task.group_folder,
          title: data.title !== undefined ? data.title : (task.title || null),
          prompt: basePrompt,
          scheduleType,
          scheduleValue,
          contextMode,
          model: taskModel,
          excludeTaskId: task.id,
        });
        if (duplicateTask) {
          logger.info(
            { taskId: task.id, existingTaskId: duplicateTask.id },
            'Duplicate task update ignored via IPC',
          );
          break;
        }

        updateTask(data.taskId, {
          title: data.title !== undefined ? data.title || null : undefined,
          prompt: buildStoredTaskPrompt(basePrompt, contextMode, task.chat_jid),
          model: taskModel,
          schedule_type: scheduleType,
          schedule_value: scheduleValue,
          context_mode: contextMode,
          next_run: nextRun,
        });
        logger.info(
          {
            taskId: data.taskId,
            sourceGroup,
            model: taskModel || 'default',
            contextMode,
          },
          'Task updated via IPC',
        );
        refreshTaskSnapshots(deps);
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          refreshTaskSnapshots(deps);
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          refreshTaskSnapshots(deps);
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          refreshTaskSnapshots(deps);
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'request_pr':
      await handleRequestPr(data, sourceGroup, deps);
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

// Forbidden path patterns — reject PRs that touch these files
const FORBIDDEN_PR_PATHS = [
  /^\.github\/workflows\//,
  /^\.env/,
];

const CARDMAXXING_GROUP_FOLDER = 'cardmaxxing';
const CARDMAXXING_BRANCH_REGEX = /^claw\/issue-\d+$/;
const BOT_CLONE_DIR = path.join(
  process.env.HOME || os.homedir(),
  '.cache', 'nanoclaw', 'repos', 'cardmaxxing',
);

async function handleRequestPr(
  data: {
    requestId?: string;
    branch?: string;
    title?: string;
    body?: string;
    issueNumber?: number;
  },
  sourceGroup: string,
  deps: IpcDeps,
): Promise<void> {
  const replyDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'replies');

  const writeReply = (requestId: string, payload: { success: boolean; prUrl?: string; error?: string }) => {
    const replyFile = path.join(replyDir, `${requestId}.json`);
    fs.mkdirSync(replyDir, { recursive: true });
    fs.writeFileSync(replyFile, JSON.stringify(payload));
    logger.info({ requestId, sourceGroup, payload }, 'request_pr reply written');
  };

  const { requestId, branch, title, body } = data;

  if (!requestId || !branch || !title || !body) {
    logger.warn({ data, sourceGroup }, 'request_pr missing required fields');
    if (requestId) writeReply(requestId, { success: false, error: 'Missing required fields: requestId, branch, title, body' });
    return;
  }

  // Authorization: only the cardmaxxing group may request PRs
  if (sourceGroup !== CARDMAXXING_GROUP_FOLDER) {
    logger.warn({ sourceGroup }, 'request_pr blocked: only cardmaxxing group may use this verb');
    writeReply(requestId, { success: false, error: 'Unauthorized: request_pr is restricted to the cardmaxxing group' });
    return;
  }

  // Branch name validation (Layer B)
  if (!CARDMAXXING_BRANCH_REGEX.test(branch)) {
    logger.warn({ branch }, 'request_pr blocked: branch name failed regex validation');
    writeReply(requestId, { success: false, error: `Branch "${branch}" does not match required pattern ^claw/issue-\\d+$` });
    return;
  }

  // Bot clone must exist
  if (!fs.existsSync(BOT_CLONE_DIR)) {
    const err = `Bot clone not found at ${BOT_CLONE_DIR}. Run scripts/setup-cardmaxxing.ts first.`;
    logger.error({ BOT_CLONE_DIR }, err);
    writeReply(requestId, { success: false, error: err });
    return;
  }

  // Fetch latest state and diff against main
  const fetchResult = spawnSync('git', ['-C', BOT_CLONE_DIR, 'fetch', 'origin'], { encoding: 'utf-8' });
  if (fetchResult.status !== 0) {
    const err = `git fetch failed: ${fetchResult.stderr}`;
    logger.error({ err }, 'request_pr: git fetch failed');
    writeReply(requestId, { success: false, error: err });
    return;
  }

  const diffResult = spawnSync(
    'git',
    ['-C', BOT_CLONE_DIR, 'diff', '--name-only', `origin/main..${branch}`],
    { encoding: 'utf-8' },
  );
  if (diffResult.status !== 0) {
    const err = `git diff failed: ${diffResult.stderr}`;
    logger.error({ branch, err }, 'request_pr: diff check failed');
    writeReply(requestId, { success: false, error: err });
    return;
  }

  const changedFiles = diffResult.stdout.trim().split('\n').filter(Boolean);
  for (const file of changedFiles) {
    for (const pattern of FORBIDDEN_PR_PATHS) {
      if (pattern.test(file)) {
        const err = `PR blocked: changed file "${file}" matches forbidden pattern ${pattern}`;
        logger.warn({ branch, file }, err);
        writeReply(requestId, { success: false, error: err });
        return;
      }
    }
  }

  // Read push PAT (host-only — never passed to containers)
  const pushEnv = readEnvFile(['GITHUB_TOKEN_PUSH']);
  const pushToken = pushEnv.GITHUB_TOKEN_PUSH;
  if (!pushToken) {
    const err = 'GITHUB_TOKEN_PUSH not set in .env';
    logger.error(err);
    writeReply(requestId, { success: false, error: err });
    return;
  }

  // Push branch (using embedded token in URL so no credential helper needed)
  const pushUrl = `https://x-access-token:${pushToken}@github.com/Cardmaxxing/cardmaxxing.git`;
  const pushResult = spawnSync(
    'git',
    ['-C', BOT_CLONE_DIR, 'push', pushUrl, `${branch}:refs/heads/${branch}`],
    { encoding: 'utf-8', timeout: 60_000 },
  );
  if (pushResult.status !== 0) {
    const err = `git push failed: ${pushResult.stderr}`;
    logger.error({ branch, err }, 'request_pr: push failed');
    writeReply(requestId, { success: false, error: err });
    return;
  }
  logger.info({ branch }, 'request_pr: branch pushed successfully');

  // Create draft PR
  const prResult = spawnSync(
    'gh',
    [
      'pr', 'create',
      '--repo', 'Cardmaxxing/cardmaxxing',
      '--draft',
      '--base', 'main',
      '--head', branch,
      '--title', title,
      '--body', body,
    ],
    {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, GITHUB_TOKEN: pushToken },
    },
  );

  if (prResult.status !== 0) {
    const err = `gh pr create failed: ${prResult.stderr}`;
    logger.error({ branch, err }, 'request_pr: PR creation failed');
    writeReply(requestId, { success: false, error: err });
    return;
  }

  const prUrl = prResult.stdout.trim();
  logger.info({ branch, prUrl }, 'request_pr: draft PR created');
  writeReply(requestId, { success: true, prUrl });

  // Notify main group
  if (prUrl) {
    const registeredGroups = deps.registeredGroups();
    const mainGroupEntry = Object.entries(registeredGroups).find(
      ([, g]) => g.folder === MAIN_GROUP_FOLDER,
    );
    if (mainGroupEntry) {
      const [mainJid] = mainGroupEntry;
      await deps.sendMessage(mainJid, `Cardmaxxing PR opened: ${prUrl}`).catch((err) => {
        logger.warn({ err }, 'request_pr: failed to notify main group');
      });
    }
  }
}
