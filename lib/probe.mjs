/**
 * 环境与健康探测。
 *
 * 面板「现在能不能用」只认这里产出的 health items：
 *   { id, label, state: 'ok'|'warn'|'fail', detail, fix?: {suffix, body?, label} }
 * 结果 30s 缓存（`health({force:true})` 跳过缓存），避免面板每次刷新都扫盘/起 PowerShell。
 *
 * 同时提供 FLM 已安装模型清单（`flm list` 失败时退回 model_list.json + 扫目录）。
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { detectHardware } from './detect.mjs'
import { installed as runtimeInstalled, RUNTIMES } from './runtimes.mjs'

export const HEALTH_IDS = ['config', 'dataRoot', 'npu', 'gpu', 'flm', 'runtime', 'port', 'models', 'log', 'hybrid']
export const DEFAULT_CACHE_MS = 30000

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }

/* ------------------------------------------------------ FLM 模型清单 */

/** flm.exe 旁边的 model_list.json：把「目录名 → 模型 tag」映出来 */
export function readFlmCatalog(exe) {
  if (!exe || !isFile(exe)) return []
  const file = path.join(path.dirname(exe), 'model_list.json')
  let j = null
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
  const out = []
  const families = (j && j.models) || {}
  for (const [family, versions] of Object.entries(families)) {
    for (const [ver, meta] of Object.entries(versions || {})) {
      out.push({
        id: `${family}:${ver}`,
        dirName: (meta && meta.name) || '',
        ctx: Number(meta && meta.default_context_length) || 0,
        labels: [meta && meta.details && meta.details.family, meta && meta.details && meta.details.parameter_size].filter(Boolean),
      })
    }
  }
  return out
}

/** 问 flm 要已安装模型清单；失败就回空数组（设置面板会提示手动填） */
export function flmListModels(exePath, env) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(exePath || 'flm', ['list', '--filter', 'installed', '-j'], {
        windowsHide: true,
        env: { ...process.env, ...(env || {}) },
      })
    } catch { resolve([]); return }
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolve([]) }, 15000)
    child.stdout.on('data', (c) => { out += c })
    child.on('error', () => { clearTimeout(timer); resolve([]) })
    child.on('exit', () => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out)
        resolve((j.models || []).map((m) => ({
          id: m.model,
          size: m.size,
          ctx: m.default_context_length,
          labels: m.label || [],
          installed: !!m.installed,
        })))
      } catch { resolve([]) }
    })
  })
}

/**
 * FLM 已安装模型清单：
 * 先问 `flm list --filter installed`；如果 FLM 自己的模型路径和插件的 flmDir 不一致
 * （升级/迁移后很常见），退回读它安装目录里的 model_list.json + 扫 flmDir 的模型文件夹。
 */
export async function listFlmInstalled(opts = {}) {
  const exe = isFile(String(opts.flmExe || '')) ? opts.flmExe : ''
  const backend = opts.backend || null
  if (exe) {
    let env = {}
    try { env = backend && typeof backend.flmSpawnEnv === 'function' ? backend.flmSpawnEnv() : {} } catch { env = {} }
    const list = await flmListModels(exe, env)
    if (list.length) return list
  }
  let dir = ''
  try { dir = backend && typeof backend.flmDir === 'function' ? backend.flmDir() : '' } catch { dir = '' }
  if (!dir) return []
  let top = []
  try { top = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { /* 没模型 */ }
  const isModelDir = (d) => {
    try {
      return fs.readdirSync(d).some((n) => /^(model\.q4nx|configuration\.json|config\.json)$/i.test(n))
    } catch { return false }
  }
  const dirs = []
  for (const name of top) {
    const full = path.join(dir, name)
    if (isModelDir(full)) dirs.push(name)
    else {
      try {
        for (const e of fs.readdirSync(full, { withFileTypes: true })) {
          if (e.isDirectory() && isModelDir(path.join(full, e.name))) dirs.push(e.name)
        }
      } catch { /* ignore */ }
    }
  }
  const byDir = new Map(readFlmCatalog(exe).map((c) => [c.dirName.toLowerCase(), c]))
  return dirs.map((d) => {
    const hit = byDir.get(d.toLowerCase())
    if (hit) return { id: hit.id, size: 0, ctx: hit.ctx, labels: hit.labels, installed: true }
    return { id: d.replace(/-NPU\d+$/i, '').toLowerCase(), size: 0, ctx: 0, labels: [], installed: true }
  })
}

/* ---------------------------------------------------------- 端口探测 */

export function checkPortFree(port, host = '127.0.0.1') {
  const p = Number(port) || 0
  if (!p) return Promise.resolve(true)
  return new Promise((resolve) => {
    const srv = net.createServer()
    let done = false
    const finish = (free) => {
      if (done) return
      done = true
      try { srv.close() } catch { /* ignore */ }
      resolve(free)
    }
    srv.once('error', (e) => finish(!(e && e.code === 'EADDRINUSE')))
    srv.once('listening', () => finish(true))
    try { srv.listen(p, host) } catch { finish(true) }
  })
}

/* ------------------------------------------------------------ 探测主体 */

/**
 * @param {{
 *   getConfig: () => object,
 *   configFile?: () => string,
 *   getBackend?: () => object|null,
 *   getSupervisor?: () => object|null,
 *   getLogFile?: () => string,
 *   getHybrid?: () => object|null,
 *   getModels?: () => Promise<object>|object,
 *   detect?: () => Promise<object>,
 *   checkPort?: (port:number, host:string) => Promise<boolean>,
 *   log?: Function,
 *   now?: () => number,
 *   cacheMs?: number,
 * }} opts
 */
export function createProbe(opts = {}) {
  const getConfig = opts.getConfig || (() => ({}))
  const getBackend = opts.getBackend || (() => null)
  const getSupervisor = opts.getSupervisor || (() => null)
  const getLogFile = opts.getLogFile || (() => '')
  const getHybrid = opts.getHybrid || (() => null)
  const detect = opts.detect || (() => detectHardware())
  const checkPort = opts.checkPort || checkPortFree
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const cacheMs = Number(opts.cacheMs) >= 0 ? Number(opts.cacheMs) : DEFAULT_CACHE_MS
  let cache = null

  function invalidate() { cache = null }

  function item(id, label, state, detail, fix) {
    const out = { id, label, state, detail: String(detail || '') }
    if (fix) out.fix = fix
    return out
  }

  async function build() {
    const cfg = (() => { try { return getConfig() || {} } catch { return {} } })()
    const warnings = Array.isArray(cfg.configWarnings) ? cfg.configWarnings : []
    const items = []

    // 1. 配置文件
    const configFile = typeof opts.configFile === 'function' ? opts.configFile() : ''
    items.push(item(
      'config',
      '配置文件',
      cfg.schema === 2 ? (warnings.length ? 'warn' : 'ok') : 'fail',
      cfg.schema === 2
        ? (warnings.length ? `${configFile || 'dsh-npu.json'}：${warnings.length} 条自动修正，例：${warnings[0]}` : `${configFile || 'dsh-npu.json'} · schema v2`)
        : `${configFile || 'dsh-npu.json'}：schema 不是 v2（${cfg.schema ?? '缺失'}）`,
      warnings.length ? { suffix: 'state', label: '查看配置' } : undefined,
    ))

    // 2. 数据根
    const dataRoot = String(cfg.dataRoot || '')
    if (!dataRoot) {
      items.push(item('dataRoot', '数据根', 'fail', '未确定数据根目录', { suffix: 'config', body: { patch: { dataRoot: '' } }, label: '打开设置' }))
    } else {
      let okRoot = true
      let msg = ''
      try {
        fs.mkdirSync(dataRoot, { recursive: true })
        fs.accessSync(dataRoot, fs.constants.W_OK | fs.constants.R_OK)
      } catch (e) { okRoot = false; msg = (e && e.message) || String(e) }
      items.push(item('dataRoot', '数据根', okRoot ? 'ok' : 'fail', okRoot ? dataRoot : `${dataRoot} 不可读写：${msg}`))
    }

    // 3. NPU / 4. GPU（一次探测共用结果）
    let hw = null
    try { hw = await detect() } catch { hw = null }
    if (!hw || !hw.available) {
      items.push(item('npu', 'NPU', 'warn', '硬件探测失败（CIM/PnP 查询没有返回），点这里重新探测', { suffix: 'health?force=1', label: '重新探测' }))
      items.push(item('gpu', 'GPU', 'warn', '硬件探测失败（CIM/PnP 查询没有返回），点这里重新探测', { suffix: 'health?force=1', label: '重新探测' }))
    } else {
      const npus = Array.isArray(hw.npus) ? hw.npus : []
      items.push(item('npu', 'NPU', npus.length ? 'ok' : 'warn',
        npus.length ? npus.map((n) => n.name).join(' / ') : '未探测到 NPU（FLM 需要 AMD XDNA2）',
        npus.length ? undefined : { suffix: 'flm/detect', label: '自动查找 flm.exe' }))
      const gpus = (Array.isArray(hw.gpus) ? hw.gpus : []).filter((g) => g && !g.virtual && g.vendor)
      items.push(item('gpu', 'GPU', gpus.length ? 'ok' : 'warn',
        gpus.length ? gpus.map((g) => g.name).join(' / ') : '未探测到可用 GPU（llama.cpp 会回退 CPU）'))
    }

    // 5. FLM 可执行文件
    const flmExe = String(cfg.flmExe || '')
    if (!flmExe) {
      items.push(item('flm', 'FLM 可执行文件', 'warn', '未找到 flm.exe（可点自动查找，或直接填绝对路径）', { suffix: 'flm/detect', label: '自动查找 flm.exe' }))
    } else if (isFile(flmExe)) {
      items.push(item('flm', 'FLM 可执行文件', 'ok', flmExe))
    } else {
      items.push(item('flm', 'FLM 可执行文件', 'fail', `配置的 flm.exe 不存在：${flmExe}`, { suffix: 'flm/detect', label: '自动查找 flm.exe' }))
    }

    // 6. llama.cpp 运行时
    let runtimeRoot = ''
    try {
      const backend = getBackend()
      runtimeRoot = backend && backend.runtimeRoot ? backend.runtimeRoot : ''
    } catch { runtimeRoot = '' }
    if (!runtimeRoot) {
      try { runtimeRoot = path.join(dataRoot, 'runtimes') } catch { runtimeRoot = '' }
    }
    const installedList = Object.keys(RUNTIMES).filter((id) => {
      try { return !!runtimeInstalled(runtimeRoot, id) } catch { return false }
    })
    items.push(item('runtime', 'llama.cpp 运行时', installedList.length ? 'ok' : 'warn',
      installedList.length ? installedList.join(' / ') : '没有已安装的 llama.cpp 运行时',
      installedList.length ? undefined : { suffix: 'runtime/download', body: { id: 'llamacpp-vulkan' }, label: '安装 Vulkan 运行时' }))

    // 7. 端口
    let sup = null
    try { sup = getSupervisor() } catch { sup = null }
    let actualPort = null
    try { actualPort = sup && sup.frontURL ? Number(new URL(sup.frontURL).port) || null : null } catch { actualPort = null }
    if (sup && actualPort) {
      items.push(item('port', '代理端口', 'ok', `正在监听 127.0.0.1:${actualPort}`))
    } else {
      const want = Number(cfg.frontPort) || 0
      let free = true
      try { free = await checkPort(want, cfg.bindHost || '127.0.0.1') } catch { free = true }
      items.push(item('port', '代理端口', free ? 'ok' : 'warn',
        free ? `配置端口 ${want} 可用` : `配置端口 ${want} 被占用，启动时会改用系统分配的端口`,
        free ? undefined : { suffix: 'config', body: { patch: { frontPort: 0 } }, label: '改用自动端口' }))
    }

    // 8. 模型库
    let models = null
    try { models = await opts.getModels?.() } catch { models = null }
    let flmModels = []
    let ggufModels = []
    try { flmModels = await listFlmInstalled({ flmExe, backend: getBackend() }) } catch { flmModels = [] }
    try {
      const backend = getBackend()
      ggufModels = backend && typeof backend.listModels === 'function' ? backend.listModels() : []
    } catch { ggufModels = [] }
    const slots = Array.isArray(cfg.slots) ? cfg.slots : []
    const stale = slots.filter((s) => s && s.stale)
    const total = flmModels.length + ggufModels.length
    if (!total) {
      items.push(item('models', '模型库', 'warn', '模型库为空：去「模型」页签下载，或把 .gguf 放进 mods 目录',
        { suffix: 'models', label: '打开模型库' }))
    } else if (stale.length) {
      items.push(item('models', '模型库', 'warn', `已安装 ${total} 个模型；${stale.length} 个槽位的模型缺失`, { suffix: 'models', label: '重新选择模型' }))
    } else {
      items.push(item('models', '模型库', 'ok', `已安装 ${total} 个模型（FLM ${flmModels.length} / GGUF ${ggufModels.length}）`))
    }

    // 9. 日志
    const logFile = (() => { try { return String(getLogFile() || '') } catch { return '' } })()
    if (!logFile) {
      items.push(item('log', '日志', 'warn', '未启用日志文件（只保留内存 200 行）'))
    } else if (isFile(logFile)) {
      let size = 0
      try { size = fs.statSync(logFile).size } catch { size = 0 }
      items.push(item('log', '日志', 'ok', `${logFile} · ${Math.round(size / 1024)} KB`))
    } else {
      items.push(item('log', '日志', 'ok', `${logFile}（尚未写入，启动后自动创建）`))
    }

    // 10. 混合推理（第五框架）
    const hybridCfg = cfg.hybrid || {}
    let hstatus = null
    try { hstatus = getHybrid()?.status?.() || null } catch { hstatus = null }
    if (!hybridCfg.enabled) {
      items.push(item('hybrid', '混合推理', 'ok', '未启用（设置 → 混合推理里可开启）'))
    } else if (!hstatus) {
      items.push(item('hybrid', '混合推理', 'warn', '混合推理未就绪（模块未加载，功能自动降级为关闭）', { suffix: 'hybrid/status', label: '查看混合推理' }))
    } else if (!hstatus.ready) {
      items.push(item('hybrid', '混合推理', 'warn', '混合推理未就绪（需要 NPU 与 GPU 两端都可用）', { suffix: 'hybrid/status', label: '查看混合推理' }))
    } else {
      const engines = (hstatus.engines || []).filter((e) => e.ready).map((e) => e.id)
      items.push(item('hybrid', '混合推理', 'ok', `${hstatus.mode} · ${engines.join(' + ') || '双引擎就绪'}`))
    }

    return {
      items,
      generatedAt: new Date(now()).toISOString(),
      ok: items.every((x) => x.state !== 'fail'),
    }
  }

  async function health(opts2 = {}) {
    const force = !!(opts2 && (opts2.force || opts2.refresh))
    const t = now()
    if (!force && cache && t - cache.at < cacheMs) return cache.value
    const value = await build()
    cache = { at: t, value }
    return value
  }

  return {
    health,
    invalidate,
    healthIds: () => HEALTH_IDS.slice(),
    cachedAt: () => (cache ? cache.at : 0),
  }
}