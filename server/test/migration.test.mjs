import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {Catalog} from '../dist/catalog.js'

test('0.1.1 import is additive, idempotent and preserves all legacy metadata and duplicate directories',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-rc-migration-'))
  const file=path.join(root,'claude-rc.db'),db=new DatabaseSync(file)
  db.exec(`CREATE TABLE projects(name TEXT PRIMARY KEY,dir TEXT NOT NULL,spawn TEXT NOT NULL DEFAULT 'same-dir',autostart INTEGER NOT NULL DEFAULT 1,desired TEXT NOT NULL DEFAULT 'running',trust INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT(datetime('now')));
    CREATE TABLE conversations(remote_id TEXT PRIMARY KEY,local_id TEXT NOT NULL,project TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 0,orphan INTEGER NOT NULL DEFAULT 0,rescue_error TEXT NOT NULL DEFAULT '',last_activity INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,project TEXT,level TEXT,msg TEXT);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO projects VALUES('old-stopped','/projects/same','worktree',0,'stopped',1,'2026-01-01'),('old-running','/projects/same','same-dir',1,'running',0,'2026-01-02');
    INSERT INTO conversations VALUES('remote-kept','local-kept','old-stopped','Título que queda','waiting',1,1,'error conservado',1735000000);
    INSERT INTO meta VALUES('autoRescue','0'),('running','1'),('crashAt','2026-01-01T00:00:00Z');
    INSERT INTO events(ts,project,level,msg) VALUES('2026-01-01','old-stopped','info','registro conservado');`)
  const before=['projects','conversations','events','meta'].map(t=>db.prepare(`SELECT * FROM ${t}`).all())
  db.close()
  const contents=fs.readFileSync(file)
  fs.mkdirSync(path.join(root,'home','.claude'),{recursive:true})
  fs.writeFileSync(path.join(root,'home','.claude','bridge-spawn-test'), 'synthetic fixture')
  const catalog=new Catalog(root)
  try {
    assert.equal(catalog.importLegacy(),2)
    assert.equal(catalog.importLegacy(),0)
    assert.equal(catalog.projects().length,2)
    const old=catalog.projects().find(p=>p.name==='old-stopped')
    assert.equal(old.bindings[0].key,'old-stopped')
    assert.equal(old.bindings[0].spawn,'worktree')
    assert.equal(old.bindings[0].trust,true)
    const codex=catalog.add('only-codex','/projects/new')
    catalog.bind(codex.id,'codex','42',false)
    assert.equal(catalog.importLegacy(),0)
    const after=new DatabaseSync(file,{readOnly:true})
    assert.deepEqual(['projects','conversations','events','meta'].map(t=>after.prepare(`SELECT * FROM ${t}`).all()),before)
    after.close()
    assert.deepEqual(fs.readFileSync(file),contents)
    assert.equal(fs.readFileSync(path.join(root,'home','.claude','bridge-spawn-test'),'utf8'),'synthetic fixture')
    catalog.setEnabled('codex',false)
    assert.equal(catalog.enabled('codex'),false)
    assert.equal(catalog.enabled('claude'),true)
  } finally { catalog.close(); fs.rmSync(root,{recursive:true,force:true}) }
})
