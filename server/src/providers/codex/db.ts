import fs from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {config, dbPath} from './config.js'

fs.mkdirSync(config.dataDir, {recursive: true})
export const db = new DatabaseSync(dbPath)
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL UNIQUE,
    trust INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
`)

export type Project = {id: number; name: string; path: string; trust: number}
export type EventLevel = 'info' | 'ok' | 'warn' | 'error'
export const q = {
  projects: () => db.prepare('SELECT id,name,path,trust FROM projects ORDER BY id').all() as Project[],
  project: (id: number) => db.prepare('SELECT id,name,path,trust FROM projects WHERE id=?').get(id) as Project | undefined,
  addProject: (name: string, path: string, trust: boolean) => Number(db.prepare('INSERT INTO projects(name,path,trust) VALUES(?,?,?)').run(name,path,Number(trust)).lastInsertRowid),
  setTrust: (id: number, trust: boolean) => db.prepare('UPDATE projects SET trust=? WHERE id=?').run(Number(trust),id),
  deleteProject: (id: number) => db.prepare('DELETE FROM projects WHERE id=?').run(id),
  meta: (key: string) => (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value: string} | undefined)?.value,
  setMeta: (key: string, value: string) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value),
  // Solo mensajes definidos por la aplicación. Nunca se pasa stdout, stderr ni errores de Codex.
  event: (level: EventLevel, message: string) => {
    db.prepare('INSERT INTO events(level,message) VALUES(?,?)').run(level,message)
    db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 1000)').run()
    console.log(`[${level}] ${message}`)
  },
  events: () => db.prepare('SELECT at,level,message FROM events ORDER BY id DESC LIMIT 100').all(),
}
