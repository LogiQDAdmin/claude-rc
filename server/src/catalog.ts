import fs from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import type {ProjectBinding, ProviderId, UnifiedProject} from './provider-types.js'

// This catalog is additive. The legacy database and its metadata remain owned
// by the Claude driver; Codex-only projects never enter its projects table.
export class Catalog {
  readonly db: DatabaseSync
  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, {recursive: true})
    this.db = new DatabaseSync(path.join(dataDir, 'agent-rc.db'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS app_projects(id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, legacy_name TEXT UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_bindings(project_id INTEGER NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK(provider IN ('claude','codex')), provider_key TEXT NOT NULL, trust INTEGER NOT NULL, spawn TEXT NOT NULL DEFAULT 'same-dir', PRIMARY KEY(project_id,provider), UNIQUE(provider,provider_key));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
  }
  importLegacy(): number {
    const source = path.join(this.dataDir, 'claude-rc.db')
    if (!fs.existsSync(source)) return 0
    const legacy = new DatabaseSync(source, {readOnly: true})
    try {
      const table = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get()
      if (!table) return 0
      const rows = legacy.prepare('SELECT name,dir,trust,spawn FROM projects').all() as {name:string;dir:string;trust:number;spawn:string}[]
      let count = 0
      this.db.exec('BEGIN')
      try {
        for (const row of rows) {
          if (this.db.prepare('SELECT 1 FROM provider_bindings WHERE provider=? AND provider_key=?').get('claude', row.name)) continue
          let project = this.db.prepare('SELECT id FROM app_projects WHERE legacy_name=?').get(row.name) as {id:number}|undefined
          if (!project) {
            const inserted = this.db.prepare('INSERT INTO app_projects(name,path,legacy_name,created_at) VALUES(?,?,?,?)').run(row.name,row.dir,row.name,Date.now())
            project = {id:Number(inserted.lastInsertRowid)}
          }
          this.bind(project.id,'claude',row.name,row.trust === 1,row.spawn === 'worktree' ? 'worktree' : 'same-dir')
          count++
        }
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
      return count
    } finally { legacy.close() }
  }
  projects(): UnifiedProject[] {
    return (this.db.prepare('SELECT id,name,path FROM app_projects ORDER BY id').all() as {id:number;name:string;path:string}[]).map(row => ({...row,bindings:this.bindings(row.id)}))
  }
  project(id:number): UnifiedProject|undefined { return this.projects().find(row => row.id === id) }
  bindings(id:number): ProjectBinding[] {
    return (this.db.prepare('SELECT provider,provider_key AS key,trust,spawn FROM provider_bindings WHERE project_id=? ORDER BY provider').all(id) as any[]).map(row => ({...row,trust:row.trust === 1}))
  }
  add(name:string, directory:string): UnifiedProject {
    const row = this.db.prepare('INSERT INTO app_projects(name,path,created_at) VALUES(?,?,?)').run(name,directory,Date.now())
    return this.project(Number(row.lastInsertRowid))!
  }
  bind(id:number,provider:ProviderId,key:string,trust:boolean,spawn:'same-dir'|'worktree'='same-dir') {
    this.db.prepare('INSERT INTO provider_bindings(project_id,provider,provider_key,trust,spawn) VALUES(?,?,?,?,?) ON CONFLICT(project_id,provider) DO UPDATE SET provider_key=excluded.provider_key,trust=excluded.trust,spawn=excluded.spawn').run(id,provider,key,trust?1:0,spawn)
  }
  unbind(id:number,provider:ProviderId) { this.db.prepare('DELETE FROM provider_bindings WHERE project_id=? AND provider=?').run(id,provider) }
  remove(id:number) { this.db.prepare('DELETE FROM app_projects WHERE id=?').run(id) }
  enabled(provider:ProviderId) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(`enabled:${provider}`)?.value !== '0' }
  setEnabled(provider:ProviderId,enabled:boolean) { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`enabled:${provider}`,enabled?'1':'0') }
  close() { this.db.close() }
}
