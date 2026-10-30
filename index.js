/**
 * dsh-npu v1.0.0「燧心 / Hearthcore」入口（薄层）。
 *
 * 这里只做装配与生命周期，不再实现业务：
 *   配置（lib/config）→ 日志（lib/log）→ 后端服务（lib/backend-service）
 *   → 进程与代理（lib/supervisor）→ 探测（lib/probe）→ provider（lib/provider）
 *   → 第五框架（lib/hybrid）→ 框架更新（lib/framework-update）
 *   → 唯一路由表（lib/panel-api，面板 /plugins/dsh-npu/panel + 兼容 /npu/*）。
 *
 * 纪律：所有推理进程由 NpuSupervisor 持有（Windows Job Object 连带杀），DSH 退出进程树清零；
 * 对外只开一个代理端口；配置只有一个写入口（ConfigStore）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  ConfigStore, DEFAULT_CONFIG_FILE, HYBRID_DEFAULTS, publicConfig, resolveDataRoot,
  flmCandidates, deepFindFlmExe, looksLikeDataRoot, timestamp,
} from './lib/config.mjs'
import { NpuSupervisor } from './lib/supervisor.mjs'
import { BackendService } from './lib/backend-service.mjs'
import { createPanelApi, PANEL_PREFIX, ApiError } from './lib/panel-api.mjs'
import { createProviderManager, providerModels } from './lib/provider.mjs'
import { createProbe, listFlmInstalled } from './lib/probe.mjs'
import { createLogger } from './lib/log.mjs'
import { createHybrid } from './lib/hybrid.mjs'
import { createUpdateCenter } from './lib/framework-update.mjs'
import {
  ensureStartupArgsFile, readStartupArgs, summarizeStartupArgs, resetStartupArgsFile, startupArgsFile,
} from './lib/startup-args.mjs'
import { installed as runtimeInstalled } from './lib/runtimes.mjs'

export const name = 'npu-runtime'
export const inject = ['llm']

function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return String(pkg.version || '')
  } catch { return '' }
}

const isFile = (p) => { try { return fs.statSync(String(p)).isFile() } catch { return false } }

/** LAN 地址（面板显示用） */
function lanAddresses() {
  const out = []
  try {
    for (const list of Object.values(os.networkInterfaces()) || []) {
      for (const it of list || []) {
        if (it && it.family === 'IPv4' && !it.internal) out.push(it.address)
      }
    }
  } catch { /* ignore */ }
  return out
}
export function apply(ctx, config = {}) {
  const patch = { ...(config || {}) }
  const configFile = String(patch.configFile || DEFAULT_CONFIG_FILE)
  const version = pluginVersion()
  const timers = new Set()
  let store = null
  let log = () => {}
  let svc = null
  let sup = null
  let probe = null
  let providerMgr = null
  let panel = null
  let hybrid = null
  let updater = null
  let starting = null
  let disposePanel = null
  let applyingRuntime = false

  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); try { fn() } catch (e) { log(`定时任务失败:${e && e.message}`) } }, ms)
    t.unref?.()
    timers.add(t)
    return t
  }

  /* ------------------------------------------------ 1. 配置（唯一写入口） */

  store = new ConfigStore({ file: configFile, defaults: { ...patch, configFile }, log: () => {} })
  const boot = store.load()
  if (!boot.config.dataRoot) {
    const found = resolveDataRoot(configFile, '')
    if (found) {
      store.config.dataRoot = found
      try { store.persist() } catch { /* 数据根发现失败不阻断 */ }
    }
  }
  log = createLogger({ dataRoot: store.get().dataRoot, logger: ctx.logger || null })
  store.log = log
  if (boot.migrated) log(`配置迁移完成：${configFile} → schema v2${store.backupFile ? `（备份 ${store.backupFile}）` : ''}`)
  if (store.warnings.length) log(`配置自愈 ${store.warnings.length} 条：${store.warnings.slice(0, 3).join('；')}`)
  log(`dsh-npu ${version} 启动 · 配置 ${configFile} · 数据根 ${store.get().dataRoot || '未定'}`)

  const cfg = () => store.get()
  const saveConfig = (p) => {
    const r = store.save(p)
    applyRuntimeConfig()
    log(`配置已保存（${r.changed.join(',') || 'noop'}）${r.warnings.length ? `，修正 ${r.warnings.length} 条` : ''}`)
    return r
  }

  /* --------------------------------------------- 2. 后端服务 / 进程 / 代理 */

  svc = new BackendService({
    root: cfg().dataRoot,
    pref: cfg().backendPref || 'auto',
    flmExe: cfg().flmExe || (isFile(cfg().exePath) ? cfg().exePath : ''),
    log,
  })

  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { resolve(raw.trim() ? JSON.parse(raw) : null) } catch { resolve(null) } })
    req.on('error', () => resolve(null))
  })
  const sendJson = (res, code, payload) => {
    if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    try { res.end(JSON.stringify(payload)) } catch { /* ignore */ }
  }

  /** 旧 `/npu/*` 兼容：/npu/config 保持 0.13.0 的「扁平配置」形状，其余走唯一路由表 */
  const legacyRoute = (req, res) => {
    const p = String((req && req.url) || '').split('?')[0]
    if (p === '/npu/status' || !p.startsWith('/npu/')) return false
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (p === '/npu/config') {
      const flat = () => publicConfig(cfg(), { configFile, providerModels: providerMgr.models(), version })
      if (method === 'GET') { sendJson(res, 200, flat()); return true }
      readBody(req).then((body) => {
        try {
          const patchBody = body && typeof body.patch === 'object' ? body.patch : body
          saveConfig(patchBody || {})
          sendJson(res, 200, flat())
        } catch (e) { sendJson(res, 400, { ok: false, error: { message: String((e && e.message) || e) } }) }
      })
      return true
    }
    if (!panel) { sendJson(res, 503, { ok: false, error: { message: '面板尚未就绪' } }); return true }
    panel.handleLegacy(req, res).then((handled) => {
      if (!handled) sendJson(res, 404, { ok: false, error: { message: 'unknown endpoint' } })
    }).catch((e) => sendJson(res, 500, { ok: false, error: { message: String((e && e.message) || e) } }))
    return true
  }

  sup = new NpuSupervisor({
    exePath: cfg().exePath,
    koffiPath: patch.koffiPath,
    slots: cfg().slots,
    frontPort: Number(cfg().frontPort) || 0,
    bindHost: cfg().bindHost || '127.0.0.1',
    apiToken: cfg().apiToken || '',
    readyTimeoutSec: Number(cfg().readyTimeoutSec) || 180,
    log,
    extraRoute: legacyRoute,
    // 每个槽位按 backend 取自己的可执行文件：FLM 走 flm.exe，llama.cpp 槽位走 llama-server.exe
    exeForSlot: (s) => {
      const c = cfg()
      if (String(s.backend || 'flm').startsWith('llamacpp')) return c.llamaExe || svc.exe || ''
      return c.flmExe || c.exePath || ''
    },
    env: (() => {
      const c = cfg()
      return c.dataRoot ? { FLM_MODEL_PATH: path.join(c.dataRoot, 'mods', 'flm') } : {}
    })(),
  })

  /* --------------------------------------------------------- 3. 探测 / 第五框架 */

  const firstSlot = (backend) => cfg().slots.find((s) => s.enabled !== false && (s.backend || 'flm') === backend) || null

  const ensureEngine = async (id) => {
    const slot = firstSlot(id === 'npu' ? 'flm' : 'llamacpp-vulkan') ||
      cfg().slots.find((s) => (s.backend || 'flm').startsWith(id === 'npu' ? 'flm' : 'llamacpp'))
    if (!slot) throw new Error(id === 'npu' ? '没有 FLM(NPU) 槽位' : '没有 llama.cpp(GPU) 槽位')
    // 第五框架的 GPU 引擎：第一次用之前先解析 llama.cpp 运行时（不下载，只找已装的）
    if (id === 'gpu' && !cfg().llamaExe) {
      try {
        const r = await svc.resolve(false)
        if (r && r.exe) saveConfig({ llamaExe: r.exe, backendPref: (r.chosen && r.chosen.id) || cfg().backendPref })
      } catch (e) { log(`GPU 运行时解析失败：${(e && e.message) || e}`) }
    }
    await sup.ensure(slot.id)
    return slot.id
  }
  const engineURL = (id) => {
    const slot = firstSlot(id === 'npu' ? 'flm' : 'llamacpp-vulkan') ||
      cfg().slots.find((s) => (s.backend || 'flm').startsWith(id === 'npu' ? 'flm' : 'llamacpp'))
    const live = slot && sup.slots.get(slot.id)
    if (!live || !live.port) return ''
    return `http://127.0.0.1:${live.port}/v1`
  }

  try {
    hybrid = createHybrid({
      config: cfg(),
      log,
      ensureEngine,
      engineURL,
      saveConfig: async (p) => { saveConfig(p) },
    })
    log(`混合推理（第五框架）已装配：mode=${(cfg().hybrid || {}).mode} enabled=${(cfg().hybrid || {}).enabled !== false}`)
  } catch (e) {
    hybrid = null
    log(`混合推理不可用（自动降级为单引擎）：${(e && e.message) || e}`)
  }

  probe = createProbe({
    configFile: () => configFile,
    getConfig: cfg,
    getBackend: () => svc,
    getSupervisor: () => sup,
    getLogFile: () => log.file(),
    getHybrid: () => hybrid,
    getModels: async () => {
      const flm = await listFlmInstalled({ flmExe: cfg().flmExe || cfg().exePath, backend: svc })
      return { flm, gguf: svc.listModels() }
    },
  })

  /* -------------------------------------------------------------- 4. provider */

  providerMgr = createProviderManager({
    ctx,
    getConfig: cfg,
    getBaseURL: () => (sup && sup.frontURL) || '',
    ensure: () => sup.ensure(cfg().slots.find((s) => s.enabled !== false && s.llm !== false)?.id || cfg().slots[0]?.id),
    log,
  })

  /* -------------------------------------------------------------- 5. 框架更新 */

  updater = createUpdateCenter({
    dataRoot: cfg().dataRoot,
    log,
    getFlmExe: () => cfg().flmExe || cfg().exePath,
    getMirror: () => cfg().updateMirror || '',
    getBackendPref: () => cfg().backendPref || '',
    onInstalled: ({ exe, variant }) => {
      try {
        if (variant) saveConfig({ llamaExe: exe, backendPref: variant })
        else saveConfig({ flmExe: exe, exePath: exe })
        sup.killAll()
      } catch (e) { log(`更新后应用配置失败：${(e && e.message) || e}`) }
    },
  })

  /* ------------------------------------------------------------ 6. 面板路由表 */

  const apiUrlOf = () => {
    const port = (() => { try { return Number(new URL(sup.frontURL).port) } catch { return null } })()
    const host = cfg().bindHost === '0.0.0.0' ? (lanAddresses()[0] || '127.0.0.1') : (cfg().bindHost || '127.0.0.1')
    return port ? `http://${host}:${port}/v1` : ''
  }

  const modelsSnapshot = async () => {
    const flm = await listFlmInstalled({ flmExe: cfg().flmExe || cfg().exePath, backend: svc }).catch(() => [])
    return { flm, gguf: svc.listModels() }
  }

  const handlers = {
    state: async () => {
      const models = await modelsSnapshot()
      const health = await probe.health().catch(() => ({ ok: false, items: [] }))
      const backends = await svc.inspect().catch(() => null)
      return {
        ok: true,
        version,
        config: publicConfig(cfg(), {
          configFile,
          actualPort: (() => { try { return Number(new URL(sup.frontURL).port) } catch { return null } })(),
          apiUrl: apiUrlOf(),
          lan: lanAddresses(),
          startupArgsFile: startupArgsFile(cfg().dataRoot),
          providerModels: providerMgr.models(),
          version,
        }),
        status: sup.status(),
        runningPort: (() => { try { return Number(new URL(sup.frontURL).port) || null } catch { return null } })(),
        health,
        models: [...models.flm.map((m) => ({ ...m, backend: 'flm' })), ...models.gguf.map((m) => ({ ...m, backend: 'llamacpp' }))],
        backends: backends ? {
          chosen: svc.chosen ? { id: svc.chosen.id, label: svc.chosen.label, reason: svc.chosen.reason } : null,
          devices: svc.devices || [],
          skipped: svc.skipped || [],
          list: svc.backendStates(),
          download: svc.download,
        } : null,
        hybrid: hybrid ? hybrid.status() : { enabled: false, ready: false, reason: '模块未加载' },
        updates: updater.state(),
        startupArgs: summarizeStartupArgs(readStartupArgs(cfg().dataRoot)),
      }
    },
    config: async () => ({ ok: true, config: publicConfig(cfg(), { configFile, providerModels: providerMgr.models(), version }) }),
    saveConfig: async (body) => {
      const p = body && typeof body.patch === 'object' && body.patch ? body.patch : body
      if (!p || typeof p !== 'object' || Array.isArray(p) || p.__invalid) {
        throw new ApiError(400, '配置补丁为空或不是 JSON 对象')
      }
      const r = saveConfig(p)
      return {
        ok: true,
        config: publicConfig(cfg(), { configFile, providerModels: providerMgr.models(), version }),
        warnings: r.warnings,
        restartRequired: r.restartRequired,
        changed: r.changed,
      }
    },
    health: async (_b, _req, extra) => probe.health({ force: !!(extra && extra.query && extra.query.get('force')) }),
    models: async () => {
      const m = await modelsSnapshot()
      return { ok: true, flm: m.flm, gguf: m.gguf, models: [...m.flm, ...m.gguf] }
    },
    selectModel: async (body) => {
      const backend = String((body && body.backend) || 'flm')
      const wanted = String((body && (body.name || body.model)) || '').trim()
      if (!wanted) throw new ApiError(400, '缺模型名')
      const slots = (cfg().slots || []).slice()
      const target = (body && body.slotId) ? slots.find((s) => s.id === body.slotId)
        : slots.find((s) => (s.backend || 'flm') === backend && s.llm !== false)
      if (!target) throw new ApiError(400, '没有可用的槽位')
      if (backend === 'flm') {
        const catalog = await listFlmInstalled({ flmExe: cfg().flmExe || cfg().exePath, backend: svc }).catch(() => [])
        const hit = catalog.find((m) => m.id === wanted)
        const next = { ...target, backend: 'flm', model: wanted }
        if (hit) {
          next.name = hit.name || next.name
          const ctxLen = Number(hit.ctx) || 0
          if (ctxLen > 0 && ctxLen < Number(next.contextWindow || 0)) next.contextWindow = ctxLen
        }
        if (!next.embed) next.embed = false
        slots[slots.indexOf(target)] = next
      } else {
        const file = svc.find(wanted)
        if (!file) throw new ApiError(400, '模型文件不在 mods 目录：' + wanted)
        const slot = svc.slotFor(backend, file)
        slots[slots.indexOf(target)] = { ...target, ...slot, id: target.id }
      }
      saveConfig({ slots })
      return { ok: true, slot: publicConfig(cfg(), {}).slots.find((s) => s.id === target.id) }
    },
    backends: async () => {
      const info = await svc.inspect().catch(() => null)
      const flm = await listFlmInstalled({ flmExe: cfg().flmExe || cfg().exePath, backend: svc }).catch(() => [])
      return {
        ok: true,
        hardware: info && info.hardware,
        plan: info && info.plan,
        summary: info && info.summary,
        chosen: svc.chosen ? { id: svc.chosen.id, label: svc.chosen.label, reason: svc.chosen.reason } : null,
        devices: svc.devices || [],
        skipped: svc.skipped || [],
        download: svc.download,
        flmModels: flm,
        backends: svc.backendStates().map((b) => (b.id === 'flm' ? { ...b, models: flm } : b)),
      }
    },
    setBackend: async (body) => {
      const id = String((body && body.id) || '')
      if (!id) throw new ApiError(400, '缺后端 id')
      svc.setPref(id)
      saveConfig({ backendPref: id })
      const r = await svc.resolve(true)
      sup.killAll()
      return { ok: !!r.chosen, chosen: r.chosen, devices: r.devices, skipped: r.skipped }
    },
    downloadRuntime: async (body) => {
      const id = String((body && (body.id || body.backend)) || 'llamacpp-vulkan')
      const r = await svc.downloadRuntime(id, (got, total) => { svc.download = { file: id, got, total, state: 'running' } })
      svc.download = { file: id, got: 1, total: 1, state: 'done' }
      probe.invalidate()
      saveConfig({ backendPref: id, llamaExe: r && r.exe ? r.exe : cfg().llamaExe })
      return { ok: true, id, ...(r || {}) }
    },
    downloadModel: async (body) => {
      const r = await svc.downloadModel(body || {}, (got, total) => { svc.download = { file: 'model', got, total, state: 'running' } })
      probe.invalidate()
      return { ok: true, ...(r || {}) }
    },
    deleteModel: async (body) => {
      const r = await svc.deleteModel(String((body && body.backend) || 'llamacpp'), String((body && (body.name || body.model)) || ''))
      probe.invalidate()
      return { ok: true, ...(r || {}) }
    },
    warm: async (body) => {
      const id = String((body && body.id) || (cfg().slots[0] || {}).id || '')
      if (!id) throw new ApiError(400, '没有槽位')
      await sup.ensure(id)
      return { ok: true, slot: sup.status().slots.find((s) => s.id === id) }
    },
    evict: async (body) => {
      const id = body && body.id
      if (id && sup.slots.get(id)) { const s = sup.slots.get(id); sup._kill(s) } else sup.killAll()
      return { ok: true }
    },
    hybridStatus: async () => (hybrid ? hybrid.status() : { ok: false, enabled: false, reason: '混合推理模块未加载' }),
    hybridConfig: async (body) => {
      const p = (body && body.hybrid) || (body && body.patch) || body || {}
      const snapshot = hybrid ? await hybrid.configure(p) : { ...HYBRID_DEFAULTS, ...p }
      saveConfig({ hybrid: snapshot })
      return { ok: !!hybrid, hybrid: snapshot }
    },
    hybridBench: async (body) => {
      if (!hybrid) throw new ApiError(501, '混合推理模块未加载')
      return { ok: true, ...(await hybrid.bench(body || {})) }
    },
    updates: async () => ({ ok: true, ...updater.state() }),
    checkUpdates: async () => ({ ok: true, ...(await updater.check(true)) }),
    installUpdate: async (body) => ({ ok: true, ...(await updater.install(String((body && body.id) || ''), body || {})) }),
    startupArgs: async () => ({ ok: true, ...summarizeStartupArgs(readStartupArgs(cfg().dataRoot)) }),
    reloadStartupArgs: async () => {
      ensureStartupArgsFile(cfg().dataRoot)
      return { ok: true, ...summarizeStartupArgs(readStartupArgs(cfg().dataRoot)) }
    },
    resetStartupArgs: async () => {
      resetStartupArgsFile(cfg().dataRoot)
      return { ok: true, ...summarizeStartupArgs(readStartupArgs(cfg().dataRoot)) }
    },
    openStartupArgs: async () => openInExplorer(startupArgsFile(cfg().dataRoot), true),
    logs: async (_b, req, extra) => {
      const n = Number(extra && extra.query && extra.query.get('tail')) || 200
      return { ok: true, file: log.file(), lines: log.lines(n) }
    },
    openLogs: async () => openInExplorer(log.file(), true),
    diagnostics: async () => ({
      ok: true,
      pluginVersion: version,
      configFile,
      dataRoot: cfg().dataRoot,
      logFile: log.file(),
      logSize: log.size(),
      ports: {
        front: (() => { try { return Number(new URL(sup.frontURL).port) } catch { return null } })(),
        slots: sup.status().slots.map((s) => ({ id: s.id, port: s.port, pid: s.pid })),
      },
      provider: { name: providerMgr.providerName(), models: providerMgr.models().length, error: providerMgr.lastError() },
      hybrid: hybrid ? hybrid.status() : null,
      node: process.version,
      platform: process.platform,
    }),
    // ---- 兼容端点 ----
    detectFlm: async () => {
      const found = await deepFindFlmExe({ timeoutMs: 8000, maxDirs: 4000 })
      if (!found) return { ok: false, error: '没找到 flm.exe；可以直接填绝对路径' }
      saveConfig({ flmExe: found, exePath: found })
      probe.invalidate()
      return { ok: true, exePath: found, flmExe: found }
    },
    migrateFlm: async () => {
      const r = await svc.migrateFlmDir((got, total) => { svc.download = { file: 'flm-migrate', got, total, state: 'running' } })
      svc.download = null
      return { ok: true, ...(r || {}) }
    },
    mods: async () => ({ ok: true, dir: svc.modsDir(), models: svc.listModels() }),
    downloadModsModel: async (body) => ({ ok: true, ...(await svc.downloadModel(body || {})) }),
    openMods: async () => { svc.openModelsDir('llamacpp'); return { ok: true, dir: svc.modsDir() } },
    removeRuntime: async (body) => ({ ok: true, ...(await svc.removeAddon(String((body && (body.id || body.backend)) || 'llamacpp-vulkan'))) }),
    resolve: async () => {
      const r = await svc.resolve(true)
      return { ok: !!r.chosen, chosen: r.chosen, exe: r.exe, devices: r.devices, skipped: r.skipped }
    },
  }

  panel = createPanelApi({
    ...handlers,
    // 面板挂在 DSH webServer 上，宿主已做同源校验；不在面板层固定 token 快照
    authToken: '',
  })

  /* --------------------------------------------------------- 7. 生命周期 */

  function applyRuntimeConfig() {
    if (applyingRuntime) return          // 防递归：hybrid.configure → saveConfig → applyRuntimeConfig
    applyingRuntime = true
    try {
      const c = cfg()
      if (sup) {
        sup.opts.apiToken = c.apiToken || ''            // 修 A3：token 实时生效，不再构造期快照
        sup.opts.exePath = c.exePath
        sup.opts.readyTimeoutSec = Number(c.readyTimeoutSec) || 180
        sup.updateSlots(c.slots)
      }
      if (svc) { svc.pref = c.backendPref || 'auto'; svc.flmExe = c.flmExe || c.exePath; svc.root = c.dataRoot }
      try { providerMgr.refresh() } catch (e) { log(`provider 重建失败：${(e && e.message) || e}`) }
      try { hybrid && hybrid.configure && hybrid.configure({ ...(c.hybrid || {}) }) } catch { /* ignore */ }
    } finally { applyingRuntime = false }
  }

  function openInExplorer(file, select) {
    try {
      if (!file) throw new Error('没有文件路径')
      if (!fs.existsSync(file)) fs.mkdirSync(path.dirname(file), { recursive: true })
      spawn('explorer.exe', [select ? '/select,' + file : file], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return { ok: true, file }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  async function startAll() {
    ensureStartupArgsFile(cfg().dataRoot)
    try { await sup.start() } catch (e) { log(`代理端口启动失败：${(e && e.message) || e}`) }
    // 修 A5/A6：模型清单在启动后异步取一次（供 normalize 标 stale），不在构造期同步扫盘
    try { const m = await modelsSnapshot(); store.models = m; store.set({}) } catch { /* ignore */ }
    applyRuntimeConfig()
    // 后台补环境：找不到 flm.exe 时有界扫盘（不阻塞启动）
    if (!isFile(cfg().flmExe) && !isFile(cfg().exePath) && patch.disableAutoDetect !== true) {
      later(async () => {
        const found = await deepFindFlmExe({ timeoutMs: 8000, maxDirs: 4000 }).catch(() => '')
        if (found && !isFile(cfg().flmExe)) {
          saveConfig({ flmExe: found, exePath: found })
          log(`自动发现 FLM：${found}`)
        }
      }, 1200)
    }
    // 启动 3 秒后异步检查框架更新（失败只记日志）
    if (cfg().updateCheck !== false) later(() => { updater.check(true).catch(() => {}) }, 3000)
    log(`就绪：代理 ${sup.frontURL}`)
    return sup.frontURL
  }

  function stopAll() {
    for (const t of timers) { try { clearTimeout(t) } catch { /* ignore */ } }
    timers.clear()
    try { hybrid && hybrid.dispose && hybrid.dispose() } catch { /* ignore */ }
    try { providerMgr.dispose() } catch { /* ignore */ }
    try { sup && sup.dispose() } catch { /* ignore */ }
    try { if (typeof disposePanel === 'function') disposePanel() } catch { /* ignore */ }
    try { log('已停止，进程树清零') } catch { /* ignore */ }
    log.close?.()
  }

  ctx.effect(() => {
    starting = startAll()
    return () => { try { starting && starting.catch(() => {}) } catch { /* ignore */ } stopAll() }
  })

  // 面板路由（DSH webServer），失败只记日志：/npu/* 兼容端点仍然可用
  ctx.effect(() => {
    try {
      ctx.inject(['webServer'], (scoped) => {
        try {
          const server = scoped.get ? scoped.get('webServer') : null
          if (!server || typeof server.register !== 'function') { log('webServer.register 不可用：面板不可用，/npu/* 仍可'); return }
          disposePanel = scoped.effect(
            () => server.register({ kind: 'prefix', path: PANEL_PREFIX, handler: (req, res) => panel.handler(req, res) }),
            'dsh-npu: panel route',
          )
          log(`面板路由已挂载 ${PANEL_PREFIX}`)
        } catch (e) { log(`面板路由挂载失败：${(e && e.message) || e}`) }
      })
    } catch (e) { log(`webServer 注入失败：${(e && e.message) || e}`) }
    return () => { try { if (typeof disposePanel === 'function') disposePanel() } catch { /* ignore */ } }
  })

  // 可选：给 agent 一个只读状态工具
  ctx.effect(() => {
    let tools = null
    try { tools = ctx.tools } catch { return }
    if (!tools || typeof tools.register !== 'function') return
    try {
      const off = tools.register({
        name: 'npu_status',
        description: '查看本机 NPU/GPU 推理运行时状态（端口、槽位、模型、混合推理）。不启动任何模型。',
        input: { type: 'object', properties: {}, additionalProperties: false },
        async run() {
          return {
            config: publicConfig(cfg(), { configFile, providerModels: providerMgr.models(), version }),
            status: sup.status(),
            hybrid: hybrid ? hybrid.status() : null,
          }
        },
      })
      return () => { try { if (typeof off === 'function') off() } catch { /* ignore */ } }
    } catch (e) { log(`工具注册跳过：${(e && e.message) || e}`) }
  })
}

/* 兼容：旧测试/运维脚本直接 import 这些工具函数 */
export { resolveDataRoot, flmCandidates, deepFindFlmExe, looksLikeDataRoot, publicConfig, timestamp, runtimeInstalled, providerModels, startupArgsFile, readStartupArgs, summarizeStartupArgs }