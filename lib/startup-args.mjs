/**
 * 启动参数文件：让用户不改代码就能调各框架（FLM / llama.cpp）的启动参数。
 *
 * 文件位置：<数据根>/frameworks/startup-args.json
 * 结构：
 *   {
 *     "_readme": "占位符：{model} {serveModel} {port} {ctx}；改完在面板点「重新加载启动参数」",
 *     "flm":      { "label": "FastFlowLM (AMD NPU)", "args": ["serve", "{model}", "--port", "{port}", "--quiet"] },
 *     "llamacpp": { "label": "llama.cpp",            "args": ["-m", "{model}", "--port", "{port}", "--host", "127.0.0.1", "-c", "{ctx}", "-ngl", "all", "--no-webui"] }
 *   }
 *
 * 规则：
 *   - 文件 > 内置默认；单个框架缺失时用内置默认；
 *   - 支持 {model} {serveModel} {port} {ctx} 占位符；
 *   - JSON 解析失败时整份回退默认，并在面板显示错误（不会让插件起不来）。
 */
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_STARTUP_ARGS = {
  flm: {
    label: 'FastFlowLM (AMD NPU)',
    args: ['serve', '{model}', '--port', '{port}', '--quiet'],
  },
  llamacpp: {
    label: 'llama.cpp',
    args: ['-m', '{model}', '--port', '{port}', '--host', '127.0.0.1', '-c', '{ctx}', '-ngl', 'all', '--no-webui'],
  },
}

const README = [
  '启动参数文件（JSON）。改完保存，在 dsh-npu 面板点「重新加载启动参数」；',
  '正在运行的模型进程仍用旧参数，空闲回收或点「回收所有模型进程」后新启动的进程生效。',
  '可用占位符：{model} 模型名/路径、{serveModel} 实际 serve 的模型、{port} 监听端口、{ctx} 上下文长度。',
  '不写某个框架的 args 时用内置默认；JSON 写坏会整体回退默认并在面板报错。',
].join('\n')

export function startupArgsFile(dataRoot) {
  return path.join(dataRoot || '.', 'frameworks', 'startup-args.json')
}

function defaultFileBody() {
  return {
    _readme: README,
    flm: { label: DEFAULT_STARTUP_ARGS.flm.label, args: [...DEFAULT_STARTUP_ARGS.flm.args] },
    llamacpp: { label: DEFAULT_STARTUP_ARGS.llamacpp.label, args: [...DEFAULT_STARTUP_ARGS.llamacpp.args] },
  }
}

/** 文件不存在就创建一份带说明的默认文件；返回文件路径 */
export function ensureStartupArgsFile(dataRoot) {
  const file = startupArgsFile(dataRoot)
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(defaultFileBody(), null, 2))
    }
  } catch { /* 目录只读就只走内置默认 */ }
  return file
}

/**
 * 读取启动参数文件。
 * @returns {{file:string, exists:boolean, mtime:number, entries:object, errors:string[], defaults:object}}
 */
export function readStartupArgs(dataRoot) {
  const file = ensureStartupArgsFile(dataRoot)
  const out = { file, exists: false, mtime: 0, entries: { ...DEFAULT_STARTUP_ARGS }, errors: [], defaults: DEFAULT_STARTUP_ARGS }
  try {
    const st = fs.statSync(file)
    out.exists = st.isFile()
    out.mtime = st.mtimeMs
    const raw = fs.readFileSync(file, 'utf8')
    let j = null
    try { j = JSON.parse(raw) } catch (e) {
      out.errors.push('JSON 解析失败：' + ((e && e.message) || e))
      return out
    }
    for (const key of Object.keys(DEFAULT_STARTUP_ARGS)) {
      const entry = j && j[key]
      if (!entry) continue
      if (!Array.isArray(entry.args) || !entry.args.length || entry.args.some((a) => typeof a !== 'string')) {
        out.errors.push(`${key}.args 必须是字符串数组；已回退默认`)
        continue
      }
      out.entries[key] = { label: String(entry.label || DEFAULT_STARTUP_ARGS[key].label), args: entry.args.slice() }
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT') out.errors.push(String((e && e.message) || e))
  }
  return out
}

/** 占位符替换（不修改原数组） */
export function substituteArgs(args, vars = {}) {
  const model = String(vars.model == null ? '' : vars.model)
  const serveModel = String(vars.serveModel == null ? model : vars.serveModel)
  const port = String(vars.port == null ? '' : vars.port)
  const ctx = String(vars.ctx == null ? '' : vars.ctx)
  return (args || []).map((a) => String(a)
    .replace(/\{serveModel\}/g, serveModel)
    .replace(/\{model\}/g, model)
    .replace(/\{port\}/g, port)
    .replace(/\{ctx\}/g, ctx))
}

/** 根据槽位判断它属于哪个框架 */
export function frameworkOfSlot(slot) {
  if (!slot) return 'flm'
  if (slot.framework === 'llamacpp' || slot.framework === 'flm') return slot.framework
  const args = slot.args || []
  if (args.some((a) => String(a) === '-m')) return 'llamacpp'
  return 'flm'
}

/** 槽位的最终启动参数（启动参数文件 > 槽位自带 args > 内置默认） */
export function argsForSlot(slot, readResult) {
  const key = frameworkOfSlot(slot)
  const entry = readResult && readResult.entries && readResult.entries[key]
  const tpl = entry && Array.isArray(entry.args) && entry.args.length ? entry.args : (slot.args || DEFAULT_STARTUP_ARGS[key].args)
  return substituteArgs(tpl, {
    model: slot.serveModel || slot.model,
    serveModel: slot.serveModel || slot.model,
    port: slot.port,
    ctx: slot.contextWindow || 8192,
  })
}

/** 恢复默认文件内容 */
export function resetStartupArgsFile(dataRoot) {
  const file = startupArgsFile(dataRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(defaultFileBody(), null, 2))
  return { file }
}

/** 生成给面板展示的摘要（不含文件内容） */
export function summarizeStartupArgs(loaded) {
  return {
    file: loaded.file,
    exists: loaded.exists,
    mtime: loaded.mtime,
    errors: loaded.errors,
    entries: Object.keys(loaded.entries).map((key) => ({
      key,
      label: loaded.entries[key].label,
      args: loaded.entries[key].args,
      isDefault: JSON.stringify(loaded.entries[key].args) === JSON.stringify(DEFAULT_STARTUP_ARGS[key].args),
    })),
    defaults: Object.keys(DEFAULT_STARTUP_ARGS).map((key) => ({ key, label: DEFAULT_STARTUP_ARGS[key].label, args: DEFAULT_STARTUP_ARGS[key].args })),
  }
}
