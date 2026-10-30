/**
 * 配置层：dsh-npu v1.0.0 「燧心 / Hearthcore」 schema v2。
 *
 * 这是全插件**唯一**写 `dsh-npu.json` 的地方：
 *   - `ConfigStore.load()`  读盘 + v1→v2 迁移（先备份）+ 归一化自愈
 *   - `ConfigStore.save()`  校验 + 归一化 + 原子写（tmp + rename）
 *   - `normalizeConfig()`   纯函数，加载与保存都跑：槽位 id 唯一、重复模型只留第一个、
 *                           embed 只挂非 LLM 槽位、模型不存在标 stale（不静默改模型）
 *
 * 其它模块禁止直接写 `dsh-npu.json`；需要持久化别的 JSON 时用 `atomicWriteJson`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SCHEMA_VERSION = 2
export const DEFAULT_PORT = 52630
export const DEFAULT_DISPLAY_NAME = '燧心 · 本地推理'
export const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.dsh', 'dsh-npu.json')
export const MODES = ['auto', 'npu', 'gpu', 'hybrid']
export const HYBRID_MODES = ['auto', 'route', 'race', 'cascade', 'augment']
export const HYBRID_DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'auto',
  draftModel: 'qwen3.5:0.8b',
  verifyModel: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
  shortQueryTokens: 48,
  raceTimeoutMs: 12000,
})
export const SLOT_DEFAULTS = Object.freeze({
  backend: 'flm',
  contextWindow: 8192,
  think: true,
  embed: false,
  alsoServes: [],
  idleSec: 60,
  enabled: true,
  llm: true,
})
export const DEFAULTS = Object.freeze({
  schema: SCHEMA_VERSION,
  provider: 'npu-local',
  displayName: DEFAULT_DISPLAY_NAME,
  dataRoot: '',
  mode: 'auto',
  hybrid: HYBRID_DEFAULTS,
  bindHost: '127.0.0.1',
  frontPort: DEFAULT_PORT,
  readyTimeoutSec: 180,
  apiToken: '',
  updateCheck: true,
  updateMirror: '',
  exePath: 'flm',
  flmExe: '',
  llamaExe: '',
  pinned: {},
  slots: [],
})
/** 只存在于内存 / patch 的字段，不落盘 */
export const INTERNAL_KEYS = ['configFile', 'logFile', 'koffiPath', 'runtimePort']

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : NaN)
const str = (v, fallback = '') => (v == null ? fallback : String(v))
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback)

/** 时间戳（Windows 文件名安全）：20261031-020426-123 */
export function timestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}`
}

/** 原子写 JSON：先写同目录 tmp，再 rename 覆盖。进程被杀也不会留下半截 JSON。 */
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const body = JSON.stringify(obj, null, 2) + '\n'
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, body)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw e
  }
}

export function readJsonFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch { return {} }
}

/* ------------------------------------------------------------ 槽位归一化 */

function looksLlamaSlot(slot) {
  const args = Array.isArray(slot && slot.args) ? slot.args : []
  return args.some((a) => String(a) === '-m') || /^llamacpp/.test(str(slot && slot.backend))
}

function inferBackend(slot) {
  const raw = str(slot && slot.backend).trim()
  if (raw) return raw
  return looksLlamaSlot(slot) ? 'llamacpp-vulkan' : 'flm'
}

function modelKey(backend, model) {
  return `${backend}\u0000${String(model || '').trim().toLowerCase()}`
}

function catalogHas(opts, backend, model) {
  const known = opts && opts.models
  if (!known || !model) return null
  const m = String(model).trim().toLowerCase()
  const base = path.basename(String(model).replace(/\\/g, '/')).toLowerCase()
  if (backend === 'flm' || backend === 'npu') {
    const list = known.flm
    if (!Array.isArray(list)) return null
    return list.some((x) => {
      const v = String(x && typeof x === 'object' ? (x.id || x.model) : x).trim().toLowerCase()
      return v === m || v === base
    })
  }
  if (/^llamacpp/.test(backend)) {
    const list = known.gguf
    if (!Array.isArray(list)) return null
    return list.some((x) => {
      const v = String(x && typeof x === 'object' ? (x.file || x.path || x.model) : x)
      return path.basename(v.replace(/\\/g, '/')).toLowerCase() === base
    })
  }
  return null
}

function normalizeSlot(raw, index, usedIds, usedModels, warnings, opts) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const backend = inferBackend(src)
  const model = str(src.model).trim()
  let id = str(src.id || model).trim().replace(/[^\w.-]/g, '')
  if (!id) id = `slot${index + 1}`
  if (usedIds.has(id)) {
    let n = 2
    while (usedIds.has(`${id}-${n}`)) n += 1
    warnings.push(`槽位 id 重复：${id} → 已重命名为 ${id}-${n}`)
    id = `${id}-${n}`
  }
  usedIds.add(id)

  const out = {
    ...src,
    id,
    backend,
    model,
    name: str(src.name).trim() || model || id,
    contextWindow: int(src.contextWindow) > 0 ? int(src.contextWindow) : SLOT_DEFAULTS.contextWindow,
    think: bool(src.think, SLOT_DEFAULTS.think),
    embed: bool(src.embed, SLOT_DEFAULTS.embed),
    alsoServes: Array.isArray(src.alsoServes)
      ? src.alsoServes.map((x) => str(x).trim()).filter(Boolean)
      : [],
    idleSec: Number.isFinite(Number(src.idleSec)) && Number(src.idleSec) >= 0 ? Number(src.idleSec) : SLOT_DEFAULTS.idleSec,
    enabled: bool(src.enabled, SLOT_DEFAULTS.enabled),
    llm: bool(src.llm, SLOT_DEFAULTS.llm),
    stale: !!src.stale,
  }
  if (Array.isArray(src.args)) {
    out.args = src.args.map((a) => str(a))
    if (!out.args.length) delete out.args
  } else {
    delete out.args
  }

  // 1) embed 只允许挂在非 LLM 槽位（修 0.13 chat 槽位带 --embed 1 却服务错模型的问题）
  if (out.embed && out.llm !== false) {
    out.embed = false
    warnings.push(`槽位 ${out.id} 是 LLM 槽位，embed 已关闭（embedding 需要独立的非 LLM 槽位）`)
  }

  // 2) 重复 backend+model：只留第一个，其余停用（不静默删，用户仍能在面板看到/改）
  const key = modelKey(backend, out.model)
  if (out.model && usedModels.has(key)) {
    if (out.enabled) {
      out.enabled = false
      warnings.push(`槽位 ${out.id} 与更早的槽位使用同一模型 ${out.model}，已停用避免抢占`)
    }
  } else if (out.model) {
    usedModels.add(key)
  }

  // 3) 模型不存在于后端清单：只标 stale + 警告，绝不静默改模型
  if (out.model) {
    const has = catalogHas(opts, backend, out.model)
    if (has === false) {
      out.stale = true
      warnings.push(`槽位 ${out.id} 的模型不存在：${out.model}（面板里可重选）`)
    } else if (has === true) {
      out.stale = false
    }
  } else if (out.enabled) {
    out.stale = true
    warnings.push(`槽位 ${out.id} 没有填模型，已标记为缺失`)
  }
  return out
}

/* ------------------------------------------------------------- 归一化主体 */

/**
 * 归一化（纯函数，加载与保存都跑）。窗口外的字段原样保留（向前兼容旧配置）。
 * @param {object} raw
 * @param {{models?: {flm?: any[], gguf?: any[]}}} [opts] 已知模型清单；给了才做 stale 判定
 * @returns {{config: object, warnings: string[]}}
 */
export function normalizeConfig(raw, opts = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const warnings = []
  const out = {}

  // 先原样拷贝（保留 flmSlots/backendPref 等旧字段，迁移后再清）
  for (const [k, v] of Object.entries(src)) out[k] = v

  out.schema = SCHEMA_VERSION
  out.provider = str(src.provider).trim() || DEFAULTS.provider
  out.displayName = str(src.displayName).trim() || DEFAULT_DISPLAY_NAME
  out.dataRoot = str(src.dataRoot).trim()
  out.mode = MODES.includes(src.mode) ? src.mode : DEFAULTS.mode
  if (src.mode && !MODES.includes(src.mode)) warnings.push(`未知 mode：${src.mode}，已回退 auto`)

  // hybrid：缺字段补默认；未知模式回退 auto；mode=hybrid 但未启用视为 auto
  const hsrc = src.hybrid && typeof src.hybrid === 'object' ? src.hybrid : {}
  const hybrid = {
    ...HYBRID_DEFAULTS,
    ...hsrc,
    enabled: bool(hsrc.enabled, HYBRID_DEFAULTS.enabled),
    mode: HYBRID_MODES.includes(hsrc.mode) ? hsrc.mode : HYBRID_DEFAULTS.mode,
    draftModel: str(hsrc.draftModel).trim() || HYBRID_DEFAULTS.draftModel,
    verifyModel: str(hsrc.verifyModel).trim() || HYBRID_DEFAULTS.verifyModel,
    shortQueryTokens: int(hsrc.shortQueryTokens) >= 0 ? int(hsrc.shortQueryTokens) : HYBRID_DEFAULTS.shortQueryTokens,
    raceTimeoutMs: int(hsrc.raceTimeoutMs) > 0 ? int(hsrc.raceTimeoutMs) : HYBRID_DEFAULTS.raceTimeoutMs,
  }
  if (hsrc.mode && !HYBRID_MODES.includes(hsrc.mode)) warnings.push(`未知 hybrid.mode：${hsrc.mode}，已回退 auto`)
  if (out.mode === 'hybrid' && hybrid.enabled === false) {
    out.mode = 'auto'
    warnings.push('mode 为 hybrid 但 hybrid.enabled=false，已按 auto 处理')
  }
  out.hybrid = hybrid

  out.bindHost = str(src.bindHost, DEFAULTS.bindHost).trim() || DEFAULTS.bindHost
  const port = int(src.frontPort)
  if (Number.isInteger(port) && port >= 0 && port <= 65535) out.frontPort = port
  else {
    if (src.frontPort !== undefined) warnings.push(`frontPort 非法（${JSON.stringify(src.frontPort)}），已回退 ${DEFAULT_PORT}`)
    out.frontPort = DEFAULT_PORT
  }
  const ready = int(src.readyTimeoutSec)
  out.readyTimeoutSec = Number.isInteger(ready) && ready > 0 ? ready : DEFAULTS.readyTimeoutSec
  out.apiToken = str(src.apiToken)
  out.updateCheck = bool(src.updateCheck, DEFAULTS.updateCheck)
  out.updateMirror = str(src.updateMirror).trim()
  out.exePath = str(src.exePath, DEFAULTS.exePath).trim() || DEFAULTS.exePath
  out.flmExe = str(src.flmExe).trim()
  out.llamaExe = str(src.llamaExe).trim()
  out.pinned = src.pinned && typeof src.pinned === 'object' && !Array.isArray(src.pinned) ? { ...src.pinned } : {}
  if (src.backendPref !== undefined) out.backendPref = str(src.backendPref).trim() || 'auto'

  // 槽位
  const usedIds = new Set()
  const usedModels = new Set()
  const list = Array.isArray(src.slots) ? src.slots : []
  out.slots = list.map((s, i) => normalizeSlot(s, i, usedIds, usedModels, warnings, opts))

  // 去掉只属于运行时/宿主的字段（configFile 等由 patch 提供，不落盘）
  for (const k of ['configFile', 'logFile', 'koffiPath']) delete out[k]
  // 迁移遗留：flmSlots 已合并进 slots，不再保留
  delete out.flmSlots
  out.configWarnings = warnings.slice(0, 50)
  return { config: out, warnings }
}

/* --------------------------------------------------------------- v1→v2 */

/**
 * v1 → v2：合并 flmSlots、补 displayName/mode、exePath→flmExe。
 * 幂等：schema 已是 2 时原样返回 migrated:false。
 * @returns {{config: object, migrated: boolean, warnings: string[]}}
 */
export function migrateLegacy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  if (src.schema === SCHEMA_VERSION) return { config: { ...src }, migrated: false, warnings: [] }
  const warnings = []
  const out = { ...src }

  const flmSlots = Array.isArray(src.flmSlots) ? src.flmSlots : []
  const slots = Array.isArray(src.slots) ? src.slots.slice() : []
  if (flmSlots.length) {
    const seen = new Set(slots.map((s) => modelKey(inferBackend(s), str(s && s.model).trim())))
    const ids = new Set(slots.map((s) => str(s && s.id).trim()).filter(Boolean))
    let added = 0
    for (const s of flmSlots) {
      if (!s || typeof s !== 'object') continue
      const key = modelKey(inferBackend(s), str(s.model).trim())
      const id = str(s.id || s.model).trim().replace(/[^\w.-]/g, '')
      if (seen.has(key) || (id && ids.has(id))) continue
      seen.add(key)
      if (id) ids.add(id)
      slots.push(s)
      added += 1
    }
    if (added) warnings.push(`迁移：合并 ${added} 个旧 flmSlots 槽位`)
    delete out.flmSlots
  }

  if (!str(out.flmExe).trim() && /(^|[\\/])flm\.exe$/i.test(str(out.exePath).trim())) out.flmExe = out.exePath
  if (!src.mode) {
    const pref = str(src.backendPref || 'auto')
    out.mode = pref === 'flm' ? 'npu' : (/^llamacpp/.test(pref) ? 'gpu' : 'auto')
  }
  if (!str(src.displayName).trim()) out.displayName = DEFAULT_DISPLAY_NAME
  if (src.slots) out.slots = slots
  if (src.schema !== undefined) warnings.push(`配置 schema ${src.schema} → ${SCHEMA_VERSION} 已迁移`)
  out.schema = SCHEMA_VERSION
  return { config: out, migrated: true, warnings }
}

/* ------------------------------------------------------------ 补丁合并 */

/** 面板 patch 合并：槽位按 id 逐字段覆盖，保留 args/serveModel 等运行参数 */
export function applyPatch(prev, patch) {
  const base = prev && typeof prev === 'object' ? prev : {}
  const src = patch && typeof patch === 'object' ? patch : {}
  const out = { ...base }
  for (const [k, v] of Object.entries(src)) {
    if (k === 'schema') continue
    if (k === 'slots') continue
    if (k === 'hybrid' && v && typeof v === 'object') {
      out.hybrid = { ...(base.hybrid || {}), ...v }
      continue
    }
    if (k === 'pinned' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.pinned = { ...(base.pinned || {}), ...v }
      continue
    }
    out[k] = v
  }
  if (Array.isArray(src.slots)) {
    const byId = new Map((base.slots || []).map((s) => [str(s && s.id), s]))
    out.slots = src.slots.map((s, i) => {
      const cur = s && typeof s === 'object' ? s : {}
      const old = byId.get(str(cur.id)) || (base.slots || [])[i] || {}
      return { ...old, ...cur }
    })
  }
  if (src.frontPort !== undefined) {
    const p = int(src.frontPort)
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      throw new Error(`端口必须是 0-65535 的整数（0 = 自动分配；收到 ${JSON.stringify(src.frontPort)}）`)
    }
    out.frontPort = p
  }
  if (out.apiToken === '••••••') out.apiToken = base.apiToken || ''
  return out
}

/* ------------------------------------------------------------- 配置存储 */

export class ConfigStore {
  /**
   * @param {{file?: string, defaults?: object, log?: Function, models?: object}} opts
   */
  constructor(opts = {}) {
    this.file = opts.file || DEFAULT_CONFIG_FILE
    this.defaults = opts.defaults && typeof opts.defaults === 'object' ? { ...opts.defaults } : {}
    this.log = typeof opts.log === 'function' ? opts.log : () => {}
    this.models = opts.models && typeof opts.models === 'object' ? opts.models : null
    this.config = null
    this.warnings = []
    this.migrated = false
    this.backupFile = ''
  }

  raw() {
    const disk = readJsonFile(this.file)
    const merged = { ...DEFAULTS, ...this.defaults, ...disk }
    // patch 里给了 slots 而磁盘没有：patch 的槽位当默认值
    if (!disk.slots && Array.isArray(this.defaults.slots)) merged.slots = this.defaults.slots
    if (!disk.hybrid && this.defaults.hybrid) merged.hybrid = { ...HYBRID_DEFAULTS, ...this.defaults.hybrid }
    return disk
  }

  /** 加载 + 迁移（先备份）+ 归一化；需要迁移时立即落盘 v2 */
  load() {
    const disk = this.raw()
    const hasDisk = Object.keys(disk).length > 0
    const merged = { ...DEFAULTS, ...this.defaults, ...disk }
    if (!disk.slots && Array.isArray(this.defaults.slots)) merged.slots = this.defaults.slots
    if (this.defaults.hybrid) merged.hybrid = { ...HYBRID_DEFAULTS, ...this.defaults.hybrid, ...(disk.hybrid || {}) }

    const mig = migrateLegacy(merged)
    this.migrated = mig.migrated
    if (mig.migrated && hasDisk) {
      try {
        this.backupFile = `${this.file}.v1-${timestamp()}.bak`
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        fs.copyFileSync(this.file, this.backupFile)
        this.log(`配置迁移：已备份 ${this.backupFile}`)
      } catch (e) {
        this.backupFile = ''
        this.log(`配置迁移备份失败（继续迁移，原文件未动）：${(e && e.message) || e}`)
      }
    }
    const n = normalizeConfig(mig.config, { models: this.models || undefined })
    this.config = n.config
    this.warnings = [...mig.warnings, ...n.warnings]
    if (mig.migrated) this.persist()
    return { config: this.config, warnings: this.warnings, migrated: mig.migrated, backupFile: this.backupFile }
  }

  get() {
    if (!this.config) this.load()
    return this.config
  }

  /**
   * 保存 patch（唯一写入口）。先校验、再归一化、最后原子写。
   * @returns {{config: object, warnings: string[], restartRequired: boolean, changed: string[]}}
   */
  save(patch = {}) {
    const prev = this.config || this.load().config
    const next = applyPatch(prev, patch)
    const n = normalizeConfig(next, { models: this.models || undefined })
    this.persist()
    this.config = n.config
    this.warnings = n.warnings
    const restartRequired =
      Number(prev.frontPort) !== Number(n.config.frontPort) || str(prev.bindHost) !== str(n.config.bindHost)
    const changed = Object.keys(patch || {}).filter((k) => !INTERNAL_KEYS.includes(k))
    return { config: this.config, warnings: this.warnings, restartRequired, changed }
  }

  /** 内部用：把当前内存配置整份原子落盘 */
  persist() {
    const cfg = this.config
    if (!cfg) return
    const out = {}
    for (const [k, v] of Object.entries(cfg)) {
      if (INTERNAL_KEYS.includes(k)) continue
      out[k] = v
    }
    atomicWriteJson(this.file, out)
    return this.file
  }

  /** 只改内存、不落盘（自动发现类字段由 index 决定何时 save） */
  set(next) {
    const n = normalizeConfig({ ...this.get(), ...next }, { models: this.models || undefined })
    this.config = n.config
    this.warnings = n.warnings
    return this.config
  }
}

/* -------------------------------------------------------- 公开配置投影 */

export function publicSlot(slot) {
  return {
    id: slot.id,
    backend: slot.backend || 'flm',
    model: slot.model || '',
    name: slot.name || slot.model || slot.id,
    contextWindow: slot.contextWindow || 8192,
    think: slot.think !== false,
    embed: !!slot.embed,
    alsoServes: Array.isArray(slot.alsoServes) ? slot.alsoServes.slice() : [],
    idleSec: slot.idleSec == null ? 60 : slot.idleSec,
    enabled: slot.enabled !== false,
    llm: slot.llm !== false,
    stale: !!slot.stale,
    reusePort: Number(slot.reusePort) || 0,
    args: Array.isArray(slot.args) ? slot.args.slice() : null,
  }
}

/**
 * 给面板/诊断看的配置投影。
 * @param {object} cfg
 * @param {{configFile?: string, actualPort?: number|null, apiUrl?: string, lan?: string[],
 *   startupArgsFile?: string, providerModels?: any[], isFile?: (p:string)=>boolean, version?: string}} [opts]
 */
export function publicConfig(cfg, opts = {}) {
  const isFile = typeof opts.isFile === 'function'
    ? opts.isFile
    : (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
  const providerModels = Array.isArray(opts.providerModels) ? opts.providerModels : []
  return {
    schema: cfg.schema ?? SCHEMA_VERSION,
    version: opts.version || '',
    provider: cfg.provider,
    displayName: cfg.displayName,
    mode: cfg.mode || 'auto',
    hybrid: { ...HYBRID_DEFAULTS, ...(cfg.hybrid || {}) },
    exePath: cfg.exePath || '',
    exeFound: isFile(str(cfg.exePath)),
    flmExe: cfg.flmExe || '',
    flmFound: isFile(str(cfg.flmExe)),
    llamaExe: cfg.llamaExe || '',
    dataRoot: cfg.dataRoot || '',
    backendPref: cfg.backendPref || 'auto',
    frontPort: cfg.frontPort,
    bindHost: cfg.bindHost || '127.0.0.1',
    apiUrl: opts.apiUrl || '',
    lanAddresses: Array.isArray(opts.lan) ? opts.lan.slice() : [],
    readyTimeoutSec: cfg.readyTimeoutSec,
    apiToken: cfg.apiToken ? '••••••' : '',
    hasApiToken: !!cfg.apiToken,
    configFile: opts.configFile || '',
    runtimePort: opts.actualPort ?? null,
    updateCheck: cfg.updateCheck !== false,
    updateMirror: cfg.updateMirror || '',
    startupArgsFile: opts.startupArgsFile || '',
    providerModels: providerModels.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
    slots: (cfg.slots || []).map(publicSlot),
    configWarnings: Array.isArray(cfg.configWarnings) ? cfg.configWarnings.slice() : [],
  }
}

/* ------------------------------------------------- 路径与环境自动发现 */

const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const isFileSync = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

/** 一个目录像不像「数据根」：有 mods/ 或 runtimes/ 就算 */
export function looksLikeDataRoot(dir) {
  if (!dir || !isDir(dir)) return false
  return isDir(path.join(dir, 'mods')) || isDir(path.join(dir, 'runtimes'))
}

/**
 * 数据根目录。优先级：
 *   1. 配置里显式写的 dataRoot（面板/配置文件）
 *   2. 环境变量 DSH_NPU_DATA
 *   3. 历史位置：<配置文件目录>/dsh-npu-data、~/dsh-npu-data、D:\dsh-npu-data、E:\dsh-npu-data
 *   4. 兜底：配置文件所在目录
 * 只有「确实存在且看起来像数据根」的候选才会被自动采纳，避免凭空换目录。
 */
export function resolveDataRoot(configFile, configured) {
  if (configured && isDir(configured)) return configured
  const confDir = path.dirname(configFile)
  const home = os.homedir()
  const candidates = []
  if (process.env.DSH_NPU_DATA) candidates.push(process.env.DSH_NPU_DATA)
  candidates.push(path.join(confDir, 'dsh-npu-data'))
  candidates.push(path.join(home, 'dsh-npu-data'))
  candidates.push('D:\\dsh-npu-data', 'E:\\dsh-npu-data')
  for (const c of candidates) if (looksLikeDataRoot(c)) return c
  return confDir
}

/** 在 PATH 里找一个裸名字（flm → flm.exe） */
function whichInPath(raw) {
  const exts = (process.env.PATHEXT || '.EXE').split(';').filter(Boolean)
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = path.join(dir, raw + ext.toLowerCase())
      if (isFileSync(p)) return p
    }
  }
  return ''
}

/** flm.exe 的候选位置：PATH、环境变量、常见安装目录、数据根下的 flm/bin */
export function flmCandidates(configured, dataRoot) {
  const out = []
  const raw = String(configured || '').trim()
  if (raw) {
    if (path.isAbsolute(raw) || /[\\/]/.test(raw)) out.push(raw)
    else {
      const hit = whichInPath(raw)
      if (hit) out.push(hit)
    }
  }
  if (process.env.FLM_EXE) out.push(process.env.FLM_EXE)
  const name = path.basename(raw || 'flm') || 'flm'
  const exeName = /\.exe$/i.test(name) ? name : name + '.exe'
  const home = os.homedir()
  const roots = [
    path.join(home, '.flm'),
    path.join(home, '.flm', 'bin'),
    path.join(dataRoot || '', 'flm'),
    path.join(dataRoot || '', 'bin'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'flm') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'FastFlowLM') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'FastFlowLM') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'flm') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'FastFlowLM') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'flm') : '',
  ].filter(Boolean)
  for (const dir of roots) out.push(path.join(dir, exeName))
  return [...new Set(out)]
}

/**
 * 有界地扫固定磁盘，找 flm.exe（只在面板点「自动查找」时用）。
 * 限制访问目录数/耗时，避免在几百万文件的盘上卡住。
 * @returns {Promise<string>} 找到的绝对路径，找不到返回 ''
 */
export async function deepFindFlmExe(opts = {}) {
  const budget = { dirs: opts.maxDirs || 4000, deadline: Date.now() + (opts.timeoutMs || 6000) }
  const nameRe = /^flm\.exe$/i
  const skip = /(^|[\\/])(\$recycle\.bin|system volume information|windows|winsxs|node_modules|\.git|__pycache__|temp|tmp)([\\/]|$)/i
  const search = (dir, depth) => {
    if (budget.dirs <= 0 || Date.now() > budget.deadline) return ''
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return '' }
    for (const e of entries) {
      if (budget.dirs-- <= 0 || Date.now() > budget.deadline) return ''
      if (e.isFile() && nameRe.test(e.name)) return path.join(dir, e.name)
    }
    if (depth <= 0) return ''
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(dir, e.name)
      if (skip.test(full)) continue
      const found = search(full, depth - 1)
      if (found) return found
    }
    return ''
  }
  const drives = []
  for (const d of ['E:', 'D:', 'C:', 'F:', 'G:']) if (isDir(d + '\\')) drives.push(d + '\\')
  const likely = /(flm|fastflow|npu|bonsai|llm|ai-?lab|infer)/i
  const topsOf = (drive) => {
    try { return fs.readdirSync(drive, { withFileTypes: true }).filter((e) => e.isDirectory() && !skip.test(path.join(drive, e.name))) } catch { return [] }
  }
  for (const drive of drives) {
    for (const e of topsOf(drive)) {
      if (!likely.test(e.name)) continue
      const found = search(path.join(drive, e.name), 3)
      if (found) return found
    }
  }
  for (const drive of drives) {
    for (const e of topsOf(drive)) {
      const found = search(path.join(drive, e.name), 2)
      if (found) return found
    }
  }
  return ''
}