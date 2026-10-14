import fs from 'node:fs'
import path from 'node:path'
import {config} from './config.js'

const inside = (candidate:string,root:string) => {
  const relative = path.relative(root,candidate)
  return relative==='' || (!path.isAbsolute(relative) && relative!=='..' && !relative.startsWith(`..${path.sep}`))
}
export function approvedPath(input:unknown) {
  if (typeof input!=='string' || !path.isAbsolute(input) || input.includes('\0')) throw new Error('Ruta de proyecto no válida')
  const requested = path.resolve(input)
  const real = fs.realpathSync(requested)
  if (!fs.statSync(real).isDirectory()) throw new Error('La ruta debe ser una carpeta')
  if (!config.projectRoots.some(root=> {
    try { return (inside(requested,path.resolve(root)) || inside(requested,fs.realpathSync(root))) && inside(real,fs.realpathSync(root)) }
    catch { return false }
  })) throw new Error('La carpeta sale de las raíces autorizadas')
  return real
}
