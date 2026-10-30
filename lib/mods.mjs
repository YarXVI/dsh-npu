/**
 * 模型目录（mods）：插件不预装任何模型，只扫描用户自己放进来的 GGUF。
 *
 * 约定：
 *   <数据根目录>/mods/*.gguf
 *   - 文件名就是显示名（去掉 .gguf）
 *   - 量化等级从文件名里认（Q4_K_M / Q8_0 / IQ4_XS 之类）
 *   - 多层子目录也扫（方便用户按模型家族分类）
 */
import fs from 'node:fs'
import path from 'node:path'

export const MODS_DIRNAME = 'mods'

/** 从文件名里认量化等级，认不出返回空串 */
export function parseQuant(file) {
  const base = path.basename(String(file || ''), '.gguf')
  // IQ4_XS / Q4_K_M / Q8_0 / F16 / BF16 / Q4_0 等
  const m = /\b(IQ\d+_[A-Z0-9]+|Q\d+_K_[SML]|Q\d+_K|Q\d+_\d+|Q\d+|BF16|F16|F32)\b/i.exec(base)
  return m ? m[1].toUpperCase() : ''
}

/** 从文件名猜模型家族（只用于展示分组，不影响加载） */
export function parseFamily(file) {
  const base = path.basename(String(file || ''), '.gguf').toLowerCase()
  const known = ['qwen', 'llama', 'gemma', 'phi', 'mistral', 'deepseek', 'yi', 'glm', 'internlm', 'baichuan', 'minicpm']
  for (const k of known) if (base.includes(k)) return k
  return ''
}

/** 参数规模（如 1.5B / 7B），从文件名里读 */
export function parseParams(file) {
  const m = /(\d+(?:\.\d+)?)\s*B(?![a-z])/i.exec(path.basename(String(file || ''), '.gguf'))
  return m ? m[1] + 'B' : ''
}

/**
 * 扫描 mods 目录。
 * @returns {Array<{file:string, path:string, name:string, sizeMB:number, quant:string, family:string, params:string}>}
 */
export function scanMods(dir, opts = {}) {
  const maxDepth = opts.maxDepth == null ? 3 : opts.maxDepth
  const out = []

  const walk = (d, depth) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1)
        continue
      }
      if (!/\.gguf$/i.test(e.name)) continue
      // mmproj 是视觉投影文件，不是可加载的主模型
      if (/^mmproj/i.test(e.name)) continue
      let sizeMB = 0
      try { sizeMB = Math.round(fs.statSync(full).size / 1048576) } catch { /* ignore */ }
      out.push({
        file: e.name,
        path: full,
        name: e.name.replace(/\.gguf$/i, ''),
        sizeMB,
        quant: parseQuant(e.name),
        family: parseFamily(e.name),
        params: parseParams(e.name),
      })
    }
  }

  walk(dir, 0)
  // 同名文件优先浅层的，方便用户覆盖内置
  out.sort((a, b) => (a.file === b.file ? a.path.length - b.path.length : a.file.localeCompare(b.file)))
  return out
}

/** 目录不存在就建好，返回绝对路径 */
export function ensureModsDir(root) {
  const dir = path.join(root, MODS_DIRNAME)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 按名字挑模型：先精确匹配文件名，再匹配去掉扩展名的名字，最后模糊包含。
 * @returns {object|null}
 */
export function findModel(list, want) {
  const w = String(want || '').trim().toLowerCase()
  if (!w || !list || !list.length) return null
  return list.find((m) => m.file.toLowerCase() === w) ||
    list.find((m) => m.name.toLowerCase() === w) ||
    list.find((m) => m.name.toLowerCase().includes(w)) ||
    null
}
