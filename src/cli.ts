import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { executeAgentRun, findRegisteredGroupByFolder, getDisplayText } from './agent-runtime.js';
import { DATA_DIR } from './config.js';
import { getAllRegisteredGroups, initDatabase } from './db.js';

export interface CliOptions {
  groupFolder: string;
  prompt: string;
}

const CLI_IDLE_CLOSE_MS = 1500;

function usage(): string {
  return 'Usage: npm run cli -- [--group <folder>] "prompt"';
}

function hasActiveGroupContainer(groupFolder: string): boolean {
  const safeName = groupFolder.replace(/[^a-zA-Z0-9-]/g, '-');
  try {
    const output = execFileSync(
      'docker',
      ['ps', '--filter', `name=nanoclaw-${safeName}-`, '--format', '{{.Names}}'],
      { encoding: 'utf-8' },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export function parseCliArgs(argv: string[]): CliOptions {
  let groupFolder = 'main';
  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--group') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${usage()}\nMissing value for --group.`);
      }
      groupFolder = value;
      i++;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`${usage()}\nUnknown option: ${arg}`);
    }
    promptParts.push(arg);
  }

  const prompt = promptParts.join(' ').trim();
  if (!prompt) {
    throw new Error(`${usage()}\nPrompt is required.`);
  }

  return { groupFolder, prompt };
}

export async function runCli(
  argv: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, 'write'>;
    stderr: Pick<NodeJS.WriteStream, 'write'>;
  } = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  initDatabase();
  const registeredGroups = getAllRegisteredGroups();
  const target = findRegisteredGroupByFolder(registeredGroups, options.groupFolder);

  if (!target) {
    io.stderr.write(
      `Unknown group folder: ${options.groupFolder}. Register the group first or use --group main.\n`,
    );
    return 1;
  }

  if (hasActiveGroupContainer(target.group.folder)) {
    io.stderr.write(
      `Group ${target.group.folder} already has an active NanoClaw container. Wait for it to finish before using the CLI.\n`,
    );
    return 1;
  }

  let activeGroupFolder: string | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleClose = () => {
    if (!activeGroupFolder) return;
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!activeGroupFolder) return;
      const inputDir = path.join(DATA_DIR, 'ipc', activeGroupFolder, 'input');
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    }, CLI_IDLE_CLOSE_MS);
  };

  try {
    const status = await executeAgentRun({
      group: target.group,
      prompt: options.prompt,
      chatJid: target.chatJid,
      registeredGroups,
      persistSession: false,
      onProcess: (_proc, _containerName, groupFolder) => {
        activeGroupFolder = groupFolder;
      },
      onOutput: async (output) => {
        const text = getDisplayText(output.result);
        if (text) {
          io.stdout.write(`${text}\n`);
        }
        if (output.result || output.status === 'error') {
          scheduleClose();
        }
      },
    });

    return status === 'success' ? 0 : 1;
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
