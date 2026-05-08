#!/usr/bin/env tsx
/**
 * Bootstrap the cardmaxxing issue→PR loop.
 *
 * Idempotent — safe to re-run.
 *
 * What it does:
 *   1. Clones Cardmaxxing/cardmaxxing to ~/.cache/nanoclaw/repos/cardmaxxing
 *      (skips if already present)
 *   2. Adds .claw/ to .git/info/exclude so bot memory isn't tracked
 *   3. Creates .claw/MEMORY.md and .claw/JOURNAL.md if absent
 *   4. Registers the cardmaxxing group in the NanoClaw database
 *   5. Inserts the daily 9am cron task (and weekly Monday 8am compaction task)
 *
 * Run from the nanoclaw project root:
 *   npx tsx scripts/setup-cardmaxxing.ts
 */

import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOME_DIR = process.env.HOME || os.homedir();
const STORE_DIR = path.join(PROJECT_ROOT, 'store');
const BOT_CLONE_DIR = path.join(HOME_DIR, '.cache', 'nanoclaw', 'repos', 'cardmaxxing');
const CARDMAXXING_JID = 'agent:cardmaxxing@nanoclaw.local';

function openDb(): Database.Database {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Start NanoClaw at least once first.`);
    process.exit(1);
  }
  return new Database(dbPath);
}

function getMainGroupJid(db: Database.Database): string | null {
  const row = db.prepare(
    `SELECT jid FROM registered_groups WHERE folder = 'main' LIMIT 1`
  ).get() as { jid: string } | undefined;
  return row?.jid || null;
}

function cloneRepo(): void {
  if (fs.existsSync(BOT_CLONE_DIR)) {
    console.log(`Bot clone already exists at ${BOT_CLONE_DIR}, skipping clone.`);
    return;
  }
  fs.mkdirSync(path.dirname(BOT_CLONE_DIR), { recursive: true });
  console.log(`Cloning Cardmaxxing/cardmaxxing to ${BOT_CLONE_DIR}...`);
  execSync(
    `git clone https://github.com/Cardmaxxing/cardmaxxing.git "${BOT_CLONE_DIR}"`,
    { stdio: 'inherit' }
  );
  console.log('Clone complete.');
}

function setupBotMemory(): void {
  const infoExclude = path.join(BOT_CLONE_DIR, '.git', 'info', 'exclude');
  let excludeContent = '';
  try {
    excludeContent = fs.readFileSync(infoExclude, 'utf-8');
  } catch { /* file may not exist */ }

  if (!excludeContent.includes('.claw/')) {
    fs.appendFileSync(infoExclude, '\n.claw/\n');
    console.log('Added .claw/ to .git/info/exclude');
  }

  const clawDir = path.join(BOT_CLONE_DIR, '.claw');
  fs.mkdirSync(clawDir, { recursive: true });

  const memFile = path.join(clawDir, 'MEMORY.md');
  if (!fs.existsSync(memFile)) {
    fs.writeFileSync(memFile, '');
    console.log('Created .claw/MEMORY.md');
  }

  const journalFile = path.join(clawDir, 'JOURNAL.md');
  if (!fs.existsSync(journalFile)) {
    fs.writeFileSync(journalFile, '');
    console.log('Created .claw/JOURNAL.md');
  }
}

function registerGroup(db: Database.Database, mainJid: string): void {
  const containerConfig = JSON.stringify({
    additionalMounts: [
      {
        hostPath: BOT_CLONE_DIR,
        containerPath: 'repo',
        readonly: false,
      },
    ],
    timeout: 3_600_000, // 60 minutes
  });

  db.prepare(`
    INSERT OR IGNORE INTO registered_groups
      (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    CARDMAXXING_JID,
    'Cardmaxxing Loop',
    'cardmaxxing',
    '', // no trigger — scheduler is the only invoker
    new Date().toISOString(),
    containerConfig,
    0, // requiresTrigger: false
  );

  const existing = db.prepare(
    `SELECT jid FROM registered_groups WHERE jid = ?`
  ).get(CARDMAXXING_JID);
  if (existing) {
    console.log(`Group registered (jid=${CARDMAXXING_JID})`);
  }
}

function insertTask(
  db: Database.Database,
  mainJid: string,
  taskId: string,
  title: string,
  prompt: string,
  scheduleValue: string,
): void {
  const exists = db.prepare(
    `SELECT id FROM scheduled_tasks WHERE id = ?`
  ).get(taskId);

  if (exists) {
    console.log(`Task already exists: ${title} (${taskId})`);
    return;
  }

  db.prepare(`
    INSERT OR IGNORE INTO scheduled_tasks
      (id, group_folder, chat_jid, title, prompt, model, schedule_type, schedule_value,
       context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    'cardmaxxing',
    mainJid,
    title,
    prompt,
    null, // use group default model — orchestrator coordinates, Codex does the coding
    'cron',
    scheduleValue,
    'isolated',
    null, // will be set on first scheduler poll
    'active',
    new Date().toISOString(),
  );

  console.log(`Task created: ${title} (schedule: ${scheduleValue})`);
}

function main(): void {
  console.log('=== setup-cardmaxxing.ts ===\n');

  const db = openDb();

  const mainJid = getMainGroupJid(db);
  if (!mainJid) {
    console.error('Main group not registered yet. Start NanoClaw, connect WhatsApp, and register the main group first.');
    process.exit(1);
  }
  console.log(`Main group JID: ${mainJid}`);

  cloneRepo();
  setupBotMemory();
  registerGroup(db, mainJid);

  // Daily issue→PR loop: 9am every day
  insertTask(
    db,
    mainJid,
    'cardmaxxing-daily-loop',
    'Cardmaxxing daily issue→PR loop',
    `You are the orchestrator for the Cardmaxxing issue→PR loop. Follow the full workflow in your CLAUDE.md exactly:

1. Sync the bot clone to fresh origin/main.
2. Load .claw/MEMORY.md and .claw/JOURNAL.md for context.
3. List open issues with the "claw" label.
4. For each issue (up to 3): check if a branch/PR already exists, create a branch, run Codex, verify with lint/typecheck, commit, write a request_pr IPC task, and notify the main group.
5. At the end: append to JOURNAL.md and propose any MEMORY.md updates.

Abort immediately on network failure (git fetch). Never push directly.`,
    '0 9 * * *',
  );

  // Weekly memory compaction: Monday 8am
  insertTask(
    db,
    mainJid,
    'cardmaxxing-weekly-compact',
    'Cardmaxxing weekly memory compaction',
    `You are compacting the bot memory for the Cardmaxxing loop.

1. Read /workspace/extra/repo/.claw/MEMORY.md and /workspace/extra/repo/.claw/JOURNAL.md.
2. Rewrite MEMORY.md: remove stale, over-specific, or redundant entries. Keep only durable pattern-level facts. Must stay under 8 KB.
3. Trim JOURNAL.md to the last 20 entries.
4. Back up before writing: cp MEMORY.md MEMORY.md.bak, cp JOURNAL.md JOURNAL.md.bak.
5. Report what was removed and what was kept to the main group.`,
    '0 8 * * 1',
  );

  db.close();
  console.log('\nSetup complete.');
  console.log('\nNext steps:');
  console.log('  1. Add to .env: GITHUB_TOKEN_RO=<fine-grained PAT, contents:read + issues:write + pull-requests:write>');
  console.log('  2. Add to .env: GITHUB_TOKEN_PUSH=<fine-grained PAT, contents:write + pull-requests:write>');
  console.log('  3. Codex auth: run `codex login` on the host (OAuth, recommended), or add OPENAI_API_KEY to .env');
  console.log('  4. Rebuild the container: ./container/build.sh');
  console.log('  5. Restart NanoClaw: systemctl --user restart nanoclaw');
  console.log(`\nBot clone: ${BOT_CLONE_DIR}`);
  console.log(`Scheduled: daily 9am cron + Monday 8am compaction`);
}

main();
