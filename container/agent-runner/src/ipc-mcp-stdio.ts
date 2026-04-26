/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const TASKS_FILE = path.join(IPC_DIR, 'current_tasks.json');
const SNAPSHOT_CONTEXT_START = '[SNAPSHOT CONTEXT]';
const SNAPSHOT_CONTEXT_END = '[/SNAPSHOT CONTEXT]';

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

type TaskSnapshot = {
  id: string;
  chatJid?: string;
  groupFolder: string;
  title?: string | null;
  prompt: string;
  model?: string | null;
  context_mode?: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
};

function readVisibleTasks(): TaskSnapshot[] {
  if (!fs.existsSync(TASKS_FILE)) {
    return [];
  }

  const allTasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8')) as TaskSnapshot[];
  return isMain
    ? allTasks
    : allTasks.filter((t) => t.groupFolder === groupFolder);
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

function normalizeModel(model?: string): string | null {
  if (!model) return null;

  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'haiku' || normalized === 'claude-haiku-4-5') return 'claude-haiku-4-5';
  if (normalized === 'sonnet' || normalized === 'claude-sonnet-4-6') return 'claude-sonnet-4-6';
  if (normalized === 'opus' || normalized === 'claude-opus-4-6') return 'claude-opus-4-6';

  return null;
}

function normalizeTitle(title?: string): string | null {
  if (!title) return null;
  const normalized = title.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized || null;
}

function findDuplicateTask(tasks: TaskSnapshot[], params: {
  chatJid: string;
  title?: string | null;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  model: string | null;
  excludeTaskId?: string;
}): TaskSnapshot | undefined {
  const normalizedTitle = normalizeTitle(params.title || undefined);
  const normalizedPrompt = normalizePromptForComparison(params.prompt);

  return tasks.find((task) =>
    task.id !== params.excludeTaskId &&
    task.chatJid === params.chatJid &&
    task.status !== 'completed' &&
    (
      (normalizedTitle && normalizeTitle(task.title || undefined) === normalizedTitle) ||
      (
        !normalizedTitle &&
        task.schedule_type === params.schedule_type &&
        task.schedule_value === params.schedule_value &&
        (task.context_mode || 'isolated') === params.context_mode &&
        (task.model || null) === params.model &&
        normalizePromptForComparison(task.prompt) === normalizedPrompt
      )
    ),
  );
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple distinct messages. You can call this multiple times. Note: scheduled tasks also send their final non-internal output automatically, so don't repeat the same content here unless you intentionally want a duplicate.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on how much conversation state the task needs:
\u2022 "isolated": Fresh session, no conversation history. Best default for most tasks. Include all necessary context directly in the prompt.
\u2022 "snapshot": Fresh session, but NanoClaw copies a bounded snapshot of recent non-bot chat context into the task prompt when you schedule it. Use this for "follow up on what we just discussed" style tasks without paying for full session reuse later.
\u2022 "group": Reuses the group's live Claude session when the task runs. Use only as an escape hatch when the task truly needs the full ongoing conversation state at execution time.

MESSAGING BEHAVIOR - The task agent's final non-internal output is sent to the user or group automatically. It can also use send_message for progress updates or extra messages, or wrap output in <internal> tags to suppress the final auto-send. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    title: z.string().optional().describe('Optional stable task title. Recommended for dedup and later updates, e.g. "daily weather" or "weekly email review".'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated', 'snapshot']).default('isolated').describe('isolated=fresh session, snapshot=fresh session plus bounded recent chat snapshot captured now, group=reuses the group session at run time'),
    model: z.string().optional().describe('Optional Claude model for this task. Supported aliases: "haiku", "sonnet", "opus". Supported exact values: "claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6".'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    const normalizedModel = normalizeModel(args.model);
    if (args.model && !normalizedModel) {
      return {
        content: [{ type: 'text' as const, text: `Invalid model: "${args.model}". Use haiku, sonnet, opus, or an exact Claude model name.` }],
        isError: true,
      };
    }

    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;
    const visibleTasks = readVisibleTasks();
    const duplicateTask = findDuplicateTask(visibleTasks, {
      chatJid: targetJid,
      title: args.title || null,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'isolated',
      model: normalizedModel,
    });
    if (duplicateTask) {
      return {
        content: [{
          type: 'text' as const,
          text: `Likely duplicate task not created. Existing task: ${duplicateTask.id} (${duplicateTask.status}, ${duplicateTask.schedule_type}: ${duplicateTask.schedule_value}, model: ${duplicateTask.model || 'default'}, context: ${duplicateTask.context_mode || 'isolated'}). Use update_task, resume_task, or cancel_task instead.`,
        }],
        isError: true,
      };
    }

    const data = {
      type: 'schedule_task',
      title: args.title,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'isolated',
      model: normalizedModel || undefined,
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}${args.model ? ` using ${args.model}` : ''}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List scheduled tasks with full details. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    try {
      const tasks = readVisibleTasks();
      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t) =>
            [
              `Task ${t.id}`,
              `group: ${t.groupFolder}`,
              `title: ${t.title || 'N/A'}`,
              `status: ${t.status}`,
              `schedule: ${t.schedule_type} ${t.schedule_value}`,
              `next_run: ${t.next_run || 'N/A'}`,
              `model: ${t.model || 'default'}`,
              `context_mode: ${t.context_mode || 'isolated'}`,
              `prompt: ${stripSnapshotContext(t.prompt)}`,
            ].join('\n'),
        )
        .join('\n\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task without deleting and recreating it. Use this to change prompt, schedule, model, or context mode.',
  {
    task_id: z.string().describe('The task ID to update'),
    title: z.string().optional().describe('New stable task title'),
    prompt: z.string().optional().describe('New task prompt'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value'),
    context_mode: z.enum(['group', 'isolated', 'snapshot']).optional().describe('New context mode'),
    model: z.string().optional().describe('New model. Supported aliases: haiku, sonnet, opus.'),
  },
  async (args) => {
    const tasks = readVisibleTasks();
    const existingTask = tasks.find((task) => task.id === args.task_id);
    if (!existingTask) {
      return {
        content: [{ type: 'text' as const, text: `Task ${args.task_id} not found.` }],
        isError: true,
      };
    }

    const normalizedModel = args.model !== undefined ? normalizeModel(args.model) : undefined;
    if (args.model !== undefined && args.model && !normalizedModel) {
      return {
        content: [{ type: 'text' as const, text: `Invalid model: "${args.model}". Use haiku, sonnet, opus, or an exact Claude model name.` }],
        isError: true,
      };
    }

    const nextScheduleType = args.schedule_type || existingTask.schedule_type;
    const nextScheduleValue = args.schedule_value || existingTask.schedule_value;
    if (args.schedule_type || args.schedule_value) {
      if (nextScheduleType === 'cron') {
        try {
          CronExpressionParser.parse(nextScheduleValue);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${nextScheduleValue}".` }],
            isError: true,
          };
        }
      } else if (nextScheduleType === 'interval') {
        const ms = parseInt(nextScheduleValue, 10);
        if (isNaN(ms) || ms <= 0) {
          return {
            content: [{ type: 'text' as const, text: `Invalid interval: "${nextScheduleValue}". Must be positive milliseconds.` }],
            isError: true,
          };
        }
      } else {
        const date = new Date(nextScheduleValue);
        if (isNaN(date.getTime())) {
          return {
            content: [{ type: 'text' as const, text: `Invalid timestamp: "${nextScheduleValue}".` }],
            isError: true,
          };
        }
      }
    }

    const duplicateTask = findDuplicateTask(tasks, {
      chatJid: existingTask.chatJid || chatJid,
      title: args.title !== undefined ? args.title : (existingTask.title || null),
      prompt: args.prompt || stripSnapshotContext(existingTask.prompt),
      schedule_type: nextScheduleType,
      schedule_value: nextScheduleValue,
      context_mode: args.context_mode || existingTask.context_mode || 'isolated',
      model: args.model !== undefined ? (normalizedModel || null) : (existingTask.model || null),
      excludeTaskId: args.task_id,
    });
    if (duplicateTask) {
      return {
        content: [{
          type: 'text' as const,
          text: `Update would duplicate existing task ${duplicateTask.id}. Cancel or edit that task instead.`,
        }],
        isError: true,
      };
    }

    const data = {
      type: 'update_task',
      taskId: args.task_id,
      title: args.title,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode,
      model: normalizedModel,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }],
    };
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
