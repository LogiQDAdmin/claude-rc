import fs from 'node:fs'
import path from 'node:path'

export class ProjectPathError extends Error {}
function contained(candidate: string, root: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

// Comprueba tanto el nombre solicitado como el destino real. Un enlace dentro de
// /projects no autoriza a ejecutar Codex sobre una carpeta de fuera del montaje.
export function projectPath(input: unknown, roots: string[], create = false): string {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0'))
    throw new ProjectPathError('La carpeta debe ser una ruta absoluta')
  const requested = path.resolve(input)
  const allowed = roots.flatMap(root => {
    try { return [{requested: path.resolve(root), actual: fs.realpathSync(root)}] } catch { return [] }
  }).filter(root => contained(requested, root.requested))
  if (!allowed.length) throw new ProjectPathError('La carpeta tiene que estar dentro de las carpetas autorizadas')
  if (!fs.existsSync(requested)) {
    if (!create) throw new ProjectPathError('La carpeta no existe')
    let ancestor = path.dirname(requested)
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
    const actualAncestor = fs.realpathSync(ancestor)
    if (!allowed.some(root => contained(actualAncestor, root.actual))) throw new ProjectPathError('La carpeta sale de una raíz autorizada mediante un enlace')
    fs.mkdirSync(requested, {recursive: true})
  }
  const canonical = fs.realpathSync(requested)
  if (!allowed.some(root => contained(canonical, root.actual))) throw new ProjectPathError('La carpeta sale de una raíz autorizada mediante un enlace')
  if (!fs.statSync(canonical).isDirectory()) throw new ProjectPathError('La ruta debe ser una carpeta')
  return canonical
}

export function listFolders(roots: string[], usedPaths: string[]) {
  const used = new Set(usedPaths)
  return roots.map(root => {
    const folders: {path: string; name: string; git: boolean; used: boolean}[] = []
    let mounted = false
    try {
      for (const d of fs.readdirSync(root, {withFileTypes: true})) {
        if (d.name.startsWith('.') || (!d.isDirectory() && !d.isSymbolicLink())) continue
        try {
          const input = path.join(root,d.name)
          const canonical = projectPath(input, roots)
          folders.push({path: input,name: d.name,git: fs.existsSync(path.join(canonical,'.git')),used: used.has(canonical)})
        } catch { /* No mostrar enlaces fuera de las raíces permitidas. */ }
      }
      mounted = true
    } catch {}
    folders.sort((a,b) => a.name.localeCompare(b.name))
    return {root,mounted,folders}
  })
}
