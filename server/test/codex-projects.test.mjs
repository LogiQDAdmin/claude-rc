import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {projectPath,listFolders} from '../dist/providers/codex/projects.js'

test('project paths require roots, directories and explicit creation',()=> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'codex-rc-paths-'))
  try {
    const root = path.join(tmp,'projects'),outside = path.join(tmp,'outside')
    fs.mkdirSync(root); fs.mkdirSync(outside)
    assert.throws(()=>projectPath('relative',[root]),/absoluta/)
    assert.throws(()=>projectPath(outside,[root]),/autorizadas/)
    const fresh = path.join(root,'new','nested')
    assert.throws(()=>projectPath(fresh,[root]),/no existe/)
    assert.equal(projectPath(fresh,[root],true),fs.realpathSync(fresh))
    const file = path.join(root,'file')
    fs.writeFileSync(file,'fixture')
    assert.throws(()=>projectPath(file,[root]),/carpeta/)
  } finally { fs.rmSync(tmp,{recursive:true,force:true}) }
})

test('symlinks cannot escape roots, including before mkdir',()=> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'codex-rc-links-'))
  try {
    const root = path.join(tmp,'projects'),outside = path.join(tmp,'outside')
    fs.mkdirSync(root); fs.mkdirSync(outside)
    const escape = path.join(root,'escape')
    fs.symlinkSync(outside,escape,process.platform==='win32'?'junction':'dir')
    assert.throws(()=>projectPath(escape,[root]),/enlace/)
    assert.throws(()=>projectPath(path.join(escape,'must-not-exist'),[root],true),/enlace/)
    assert(!fs.existsSync(path.join(outside,'must-not-exist')))
    assert.equal(listFolders([root],[])[0].folders.length,0)
    const inside = path.join(root,'safe')
    fs.mkdirSync(inside)
    fs.symlinkSync(inside,path.join(root,'alias'),process.platform==='win32'?'junction':'dir')
    assert.equal(projectPath(path.join(root,'alias'),[root]),fs.realpathSync(inside))
    assert.equal(listFolders([root],[fs.realpathSync(inside)])[0].folders.find(f=>f.name==='alias').used,true)
  } finally { fs.rmSync(tmp,{recursive:true,force:true}) }
})
