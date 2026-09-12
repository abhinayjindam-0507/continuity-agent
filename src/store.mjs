import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const parseFile = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
};

export async function openStore(dataRoot) {
  const database = new DatabaseSync(join(dataRoot, 'continuity-agent.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);

  const count = database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
  const legacyTasks = join(dataRoot, 'tasks.json');
  if (count === 0 && existsSync(legacyTasks)) {
    const insert = database.prepare('INSERT OR REPLACE INTO tasks (id, payload, updated_at) VALUES (?, ?, ?)');
    for (const task of await parseFile(legacyTasks, [])) insert.run(task.id, JSON.stringify(task), task.updatedAt || task.createdAt || new Date().toISOString());
  }

  const legacyConfig = join(dataRoot, 'config.json');
  const hasConfig = database.prepare("SELECT 1 FROM app_config WHERE key = 'runtime'").get();
  if (!hasConfig && existsSync(legacyConfig)) {
    const config = await parseFile(legacyConfig, {});
    database.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run('runtime', JSON.stringify(config), new Date().toISOString());
  }

  return {
    getTasks() {
      return database.prepare('SELECT payload FROM tasks ORDER BY updated_at DESC').all().map(row => JSON.parse(row.payload));
    },
    saveTasks(tasks) {
      const write = database.transaction(items => {
        database.exec('DELETE FROM tasks');
        const insert = database.prepare('INSERT INTO tasks (id, payload, updated_at) VALUES (?, ?, ?)');
        for (const task of items) insert.run(task.id, JSON.stringify(task), task.updatedAt || new Date().toISOString());
      });
      write(tasks);
    },
    getConfig() {
      const row = database.prepare("SELECT value FROM app_config WHERE key = 'runtime'").get();
      return row ? JSON.parse(row.value) : {};
    },
    saveConfig(config) {
      database.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES ('runtime', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(config), new Date().toISOString());
    }
  };
}
