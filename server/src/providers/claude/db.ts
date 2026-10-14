import fs from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {config, dbPath} from './config.js'

fs.mkdirSync(config.dataDir, {recursive: true})
export const db = new DatabaseSync(dbPath)

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    dir TEXT NOT NULL,
    spawn TEXT NOT NULL DEFAULT 'same-dir',
    autostart INTEGER NOT NULL DEFAULT 1,
    desired TEXT NOT NULL DEFAULT 'running',
    trust INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS conversations (
    remote_id TEXT PRIMARY KEY,
    local_id TEXT NOT NULL,
    project TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 0,
    orphan INTEGER NOT NULL DEFAULT 0,
    rescue_error TEXT NOT NULL DEFAULT '',
    last_activity INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    project TEXT NOT NULL,
    level TEXT NOT NULL,
    msg TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`)

export type Project = {
  name: string
  dir: string
  spawn: 'same-dir' | 'worktree'
  autostart: number
  desired: 'running' | 'stopped'
  trust: number
}

export type Conversation = {
  remote_id: string
  local_id: string
  project: string
  title: string
  status: string
  active: number
  orphan: number
  rescue_error: string
  last_activity: number
}

export const q = {
  projects: () => db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Project[],
  project: (name: string) => db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Project | undefined,
  addProject: (p: Omit<Project, 'desired'>) =>
    db
      .prepare('INSERT INTO projects (name, dir, spawn, autostart, trust) VALUES (?, ?, ?, ?, ?)')
      .run(p.name, p.dir, p.spawn, p.autostart, p.trust),
  setProject: (name: string, field: 'spawn' | 'autostart' | 'desired' | 'trust', value: string | number) =>
    db.prepare(`UPDATE projects SET ${field} = ? WHERE name = ?`).run(value, name),
  deleteProject: (name: string) => {
    db.prepare('DELETE FROM projects WHERE name = ?').run(name)
    db.prepare('DELETE FROM conversations WHERE project = ?').run(name)
  },
  conversations: () =>
    db.prepare('SELECT * FROM conversations ORDER BY last_activity DESC').all() as Conversation[],
  conversation: (remoteId: string) =>
    db.prepare('SELECT * FROM conversations WHERE remote_id = ?').get(remoteId) as Conversation | undefined,
  upsertConversation: (c: Omit<Conversation, 'orphan' | 'rescue_error'>) =>
    db
      .prepare(
        `INSERT INTO conversations (remote_id, local_id, project, title, status, active, last_activity)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(remote_id) DO UPDATE SET
           local_id = excluded.local_id, project = excluded.project,
           title = CASE WHEN excluded.title != '' THEN excluded.title ELSE conversations.title END,
           status = excluded.status, active = excluded.active,
           last_activity = MAX(conversations.last_activity, excluded.last_activity)`,
      )
      .run(c.remote_id, c.local_id, c.project, c.title, c.status, c.active, c.last_activity),
  setInactiveExcept: (activeIds: string[]) => {
    const placeholders = activeIds.map(() => '?').join(',')
    db.prepare(`UPDATE conversations SET active = 0 WHERE remote_id NOT IN (${placeholders || "''"})`).run(...activeIds)
  },
  markOrphans: () => db.prepare('UPDATE conversations SET orphan = 1, rescue_error = \'\' WHERE active = 1').run(),
  setOrphan: (remoteId: string, orphan: number, error = '') =>
    db.prepare('UPDATE conversations SET orphan = ?, rescue_error = ? WHERE remote_id = ?').run(orphan, error, remoteId),
  event: (project: string, level: 'info' | 'ok' | 'warn' | 'error', msg: string) => {
    db.prepare('INSERT INTO events (project, level, msg) VALUES (?, ?, ?)').run(project, level, msg)
    console.log(`[${level}] [${project}] ${msg}`)
  },
  events: (limit: number) => db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit),
  meta: (key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as {value: string} | undefined)?.value,
  setMeta: (key: string, value: string) =>
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value),
}
