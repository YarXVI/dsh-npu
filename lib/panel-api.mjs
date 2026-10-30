/**
 * 面板 HTTP API —— 唯一路由表。
 *
 * 同一份 handler 挂两处：
 *   - `GET/POST /plugins/dsh-npu/panel/<suffix>`（DSH webServer，同源 cookie）
 *   - `/npu/<suffix>`（旧路径，代理端口上的兼容别名；明显不同于旧版的是返回形状统一成
 *     `{ok, ...}`，旧 `/npu/status` 仍由 supervisor 自己回原始状态，避免破坏运维脚本）
 *
 * 统一约定：
 *   - 成功一律 `{ok:true, ...}`；
 *   - 失败一律 `{ok:false, error:{message}}`，HTTP 状态码 4xx/5xx；
 *   - 契约 §3 的端点都在 ROUTES 里（测试直接遍历这张表做存在性校验）。
 */
import { HYBRID_MODES, MODES } from './config.mjs'

export const PANEL_PREFIX = '/plugins/dsh-npu/panel'
export const LEGACY_PREFIX = '/npu'

/** 契约 §3 冻结的端点表（顺序即文档顺序） */
export const ROUTES = Object.freeze([
  { method: 'GET', suffix: 'state', key: 'state', title: '面板总状态' },
  { method: 'POST', suffix: 'config', key: 'saveConfig', title: '写配置' },
  { method: 'GET', suffix: 'config', key: 'config', title: '读配置（兼容）' },
  { method: 'GET', suffix: 'health', key: 'health', title: '健康自检' },
  { method: 'GET', suffix: 'models', key: 'models', title: '模型清单' },
  { method: 'POST', suffix: 'model/select', key: 'selectModel', title: '选择模型进槽位' },
  { method: 'GET', suffix: 'backends', key: 'backends', title: '后端清单' },
  { method: 'POST', suffix: 'backend', key: 'setBackend', title: '切换后端' },
  { method: 'POST', suffix: 'runtime/download', key: 'downloadRuntime', title: '下载运行时' },
  { method: 'POST', suffix: 'model/download', key: 'downloadModel', title: '下载模型' },
  { method: 'POST', suffix: 'model/delete', key: 'deleteModel', title: '删除模型（移到回收站）' },
  { method: 'POST', suffix: 'slot/warm', key: 'warm', title: '加载槽位' },
  { method: 'POST', suffix: 'slot/evict', key: 'evict', title: '回收槽位（省略 id = 全部）' },
  { method: 'GET', suffix: 'hybrid/status', key: 'hybridStatus', title: '混合推理状态' },
  { method: 'POST', suffix: 'hybrid/config', key: 'hybridConfig', title: '混合推理配置' },
  { method: 'POST', suffix: 'hybrid/bench', key: 'hybridBench', title: '混合推理基准' },
  { method: 'GET', suffix: 'updates', key: 'updates', title: '框架更新状态' },
  { method: 'POST', suffix: 'updates/check', key: 'checkUpdates', title: '检查框架更新' },
  { method: 'POST', suffix: 'update', key: 'installUpdate', title: '安装框架更新' },
  { method: 'GET', suffix: 'startup-args', key: 'startupArgs', title: '启动参数文件' },
  { method: 'POST', suffix: 'startup-args/reload', key: 'reloadStartupArgs', title: '重载启动参数' },
  { method: 'POST', suffix: 'startup-args/reset', key: 'resetStartupArgs', title: '恢复默认启动参数' },
  { method: 'POST', suffix: 'startup-args/open', key: 'openStartupArgs', title: '打开启动参数文件' },
  { method: 'GET', suffix: 'logs', key: 'logs', title: '最近日志' },
  { method: 'POST', suffix: 'logs/open', key: 'openLogs', title: '打开日志文件' },
  { method: 'GET', suffix: 'diagnostics', key: 'diagnostics', title: '诊断信息' },
])

/** 兼容端点（旧版 UI / 外部脚本用；保持在 ROUTES 之外，避免把契约撑大） */
export const COMPAT_ROUTES = Object.freeze([
  { method: 'POST', suffix: 'flm/detect', key: 'detectFlm', title: '自动查找 flm.exe' },
  { method: 'POST', suffix: 'flm/migrate', key: 'migrateFlm', title: '迁移 FLM 模型目录' },
  { method: 'GET', suffix: 'mods', key: 'mods', title: 'mods 模型目录' },
  { method: 'POST', suffix: 'mods/download', key: 'downloadModsModel', title: '从镜像下载模型' },
  { method: 'POST', suffix: 'mods/open', key: 'openMods', title: '打开模型目录' },
  { method: 'POST', suffix: 'runtime/remove', key: 'removeRuntime', title: '卸载运行时（移到回收站）' },
  { method: 'POST', suffix: 'resolve', key: 'resolve', title: '重新解析后端' },
  { method: 'POST', suffix: 'model', key: 'selectModel', title: '旧版选模型' },
  { method: 'POST', suffix: 'warm', key: 'warm', title: '旧版加载槽位' },
  { method: 'POST', suffix: 'slots/evict', key: 'evict', title: '旧版回收槽位' },
])

/** 旧 `/npu/*` 与面板 suffix 的对应（``/npu/status`` 不在此表：supervisor 自己回） */
const LEGACY_SUFFIX = {
  'backends/resolve': 'resolve',
  models: 'models',
  config: 'config',
  backends: 'backends',
  mods: 'mods',
  model: 'model/select',
}

export class ApiError extends Error {
  constructor(status, message) {
    super(String(message))
    this.name = 'ApiError'
    this.status = Number(status) || 500
  }
}

const KNOWN_CONFIG_KEYS = new Set([
  'provider', 'displayName', 'dataRoot', 'mode', 'hybrid', 'bindHost', 'frontPort',
  'readyTimeoutSec', 'apiToken', 'updateCheck', 'updateMirror', 'exePath', 'flmExe',
  'llamaExe', 'backendPref', 'pinned', 'slots', 'schema',
])

function sendJson(res, status, payload) {
  let body = '{}'
  try { body = JSON.stringify(payload == null ? {} : payload) } catch { body = '{"ok":false,"error":{"message":"response not serializable"}}' }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
  } catch { /* 头已发 */ }
  try { res.end(body) } catch { /* ignore */ }
}

function readJsonBody(req) {
  if (!req || typeof req.on !== 'function') return Promise.resolve(null)
  return new Promise((resolve) => {
    let raw = ''
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
    req.on('data', (c) => {
      raw += c
      if (raw.length > 2 * 1024 * 1024) { try { req.destroy() } catch { /* ignore */ } finish(null) }
    })
    req.on('end', () => {
      if (!raw.trim()) return finish(null)
      try {
        const j = JSON.parse(raw)
        finish(j && typeof j === 'object' ? j : null)
      } catch { finish({ __invalid: true }) }
    })
    req.on('error', () => finish(null))
  })
}

function isMeaningfulConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false
  if (patch.__invalid) return false
  if (Array.isArray(patch.slots)) return true
  for (const k of Object.keys(patch)) if (KNOWN_CONFIG_KEYS.has(k)) return true
  return false
}

function unwrapPatch(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && body.patch && typeof body.patch === 'object') {
    return body.patch
  }
  return body
}

function normalizeResult(result) {
  if (result == null) return { status: 200, payload: { ok: true } }
  if (typeof result !== 'object' || Array.isArray(result)) return { status: 200, payload: { ok: true, value: result } }
  const out = { ...result }
  const status = Number(out.status) >= 100 ? Math.trunc(out.status) : (out.ok === false ? 400 : 200)
  delete out.status
  if (typeof out.error === 'string') out.error = { message: out.error }
  if (out.ok === undefined) out.ok = true
  return { status, payload: out }
}

/**
 * @param {object} deps 每个 key 对应 ROUTES/COMPAT_ROUTES 里的 handler；
 *   签名 `(body, req, ctx) => any | Promise<any>`，抛 ApiError 控制错误码。
 *   还支持：`authorize(req) => boolean`、`authToken: string`。
 */
export function createPanelApi(deps = {}) {
  const byKey = new Map()
  for (const r of [...ROUTES, ...COMPAT_ROUTES]) byKey.set(`${r.method} ${r.suffix}`, r)
  const authToken = String(deps.authToken || '')

  const authorize = (req) => {
    if (typeof deps.authorize === 'function') {
      try { if (!deps.authorize(req)) return false } catch { return false }
    }
    if (!authToken) return true
    const headers = (req && req.headers) || {}
    const auth = String(headers.authorization || '')
    if (auth === `Bearer ${authToken}`) return true
    const cookie = String(headers.cookie || '')
    return cookie.split(';').map((x) => x.trim()).includes(`dsh-npu-panel=${authToken}`)
  }

  function lookup(method, suffix) {
    return byKey.get(`${String(method || 'GET').toUpperCase()} ${suffix}`) || null
  }

  function parseQuery(req) {
    try { return new URL(String(req && req.url || '/'), 'http://localhost').searchParams } catch { return new URLSearchParams() }
  }

  /** 核心分发：返回 {status, payload}，测试可直接调用 */
  async function dispatch(method, suffix, body, req) {
    const route = lookup(method, suffix)
    if (!route) throw new ApiError(404, `unknown endpoint: ${String(method).toUpperCase()} ${suffix}`)
    if (!authorize(req || { headers: {} })) throw new ApiError(401, 'unauthorized')
    const fn = deps[route.key]
    if (typeof fn !== 'function') throw new ApiError(501, `功能未启用：${route.key}`)
    const result = await fn(body, req || {}, { route, query: parseQuery(req) })
    return normalizeResult(result)
  }

  async function handler(req, res) {
    let suffix = 'state'
    try {
      const pathname = String((req && req.url) || '/').split('?')[0]
      suffix = pathname.startsWith(PANEL_PREFIX) ? pathname.slice(PANEL_PREFIX.length).replace(/^\/+/, '') : ''
      if (!suffix) suffix = 'state'
    } catch { suffix = 'state' }
    try {
      const route = lookup(req && req.method, suffix)
      if (!route) throw new ApiError(404, `unknown endpoint: ${String(req && req.method)} ${suffix}`)
      const body = route.method === 'GET' ? null : await readJsonBody(req)
      const out = await dispatch(route.method, suffix, body, req)
      sendJson(res, out.status, out.payload)
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500
      sendJson(res, status, { ok: false, error: { message: String((e && e.message) || e) } })
    }
  }

  /**
   * 旧 `/npu/*` 兼容别名。返回 true 表示已处理；false 表示交给 supervisor 继续
   * （仅 `/npu/status`：它回的是原始进程状态，不是面板形状，保持旧契约）。
   */
  async function handleLegacy(req, res) {
    let pathname = ''
    try { pathname = String((req && req.url) || '/').split('?')[0] } catch { return false }
    if (!pathname.startsWith(`${LEGACY_PREFIX}/`)) return false
    const raw = pathname.slice(LEGACY_PREFIX.length + 1).replace(/\/+$/, '')
    if (!raw || raw === 'status') return false
    const suffix = LEGACY_SUFFIX[raw] || raw
    const method = String((req && req.method) || 'GET').toUpperCase()
    try {
      const route = lookup(method, suffix) ||
        (method === 'PUT' || method === 'PATCH' ? lookup('POST', suffix) : null)
      if (!route) throw new ApiError(404, `unknown endpoint: ${method} /npu/${raw}`)
      const body = route.method === 'GET' ? null : await readJsonBody(req)
      const out = await dispatch(route.method, route.suffix, body, req)
      sendJson(res, out.status, out.payload)
      return true
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500
      sendJson(res, status, { ok: false, error: { message: String((e && e.message) || e) } })
      return true
    }
  }

  return {
    handler,
    handleLegacy,
    dispatch,
    lookup,
    routes: ROUTES,
    compatRoutes: COMPAT_ROUTES,
    prefix: PANEL_PREFIX,
  }
}

export { MODES, HYBRID_MODES }