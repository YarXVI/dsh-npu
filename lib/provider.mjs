/**
 * LLM provider 注册 / 重建 / 模型快照。
 *
 * 面板保存槽位后要**立即**反映到 DSH 的模型选择器，所以 provider 不能只在启动时注册一次：
 * 每次配置变化都 dispose 旧 adapter、按最新槽位重建。注册失败（例如用户还留着一份同名
 * provider）只记日志，不影响代理端口继续可用。
 */
import { createAdapter } from './adapter.mjs'

/** 参与 provider 的槽位 → adapter 模型清单（纯函数，便于测试） */
export function providerModels(config) {
  return (config && config.slots || [])
    .filter((s) => s && s.enabled !== false && s.llm !== false)
    .map((s) => ({
      id: String(s.model || ''),
      name: s.name || s.model || s.id,
      contextWindow: Number(s.contextWindow) || 8192,
      think: s.think,
      extraBody: s.extraBody,
    }))
    .filter((m) => m.id)
}

/** 按 backend 给槽位分组（面板/诊断用） */
export function slotsByBackend(config) {
  const out = {}
  for (const s of (config && config.slots) || []) {
    const b = s.backend || 'flm'
    if (!out[b]) out[b] = []
    out[b].push(s)
  }
  return out
}

/**
 * @param {{
 *   ctx: object,              // DSH 插件上下文（用 ctx.llm.registerAdapter）
 *   getConfig: () => object,
 *   getBaseURL: () => string,
 *   ensure?: () => Promise<any>,
 *   log: Function,
 *   provider?: string,
 * }} opts
 */
export function createProviderManager(opts) {
  const ctx = opts.ctx || {}
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const getConfig = opts.getConfig || (() => ({}))
  const providerName = () => String((getConfig() || {}).provider || 'npu-local')
  let disposeCurrent = null
  let lastError = ''
  let lastModels = []
  let registeredAt = 0

  function dispose() {
    if (typeof disposeCurrent === 'function') {
      try { disposeCurrent() } catch { /* ignore */ }
    }
    disposeCurrent = null
    registeredAt = 0
  }

  function refresh() {
    dispose()
    const cfg = getConfig() || {}
    const models = providerModels(cfg)
    lastModels = models
    const adapter = createAdapter({
      getBaseURL: opts.getBaseURL,
      models,
      displayName: cfg.displayName,
      ensure: opts.ensure,
      log,
    })
    const provider = providerName()
    try {
      const llm = ctx.llm
      if (!llm || typeof llm.registerAdapter !== 'function') throw new Error('ctx.llm.registerAdapter 不可用')
      disposeCurrent = llm.registerAdapter([provider], adapter) || null
      lastError = ''
      registeredAt = Date.now()
      log(`provider ${provider} 注册成功，${models.length} 个模型`)
    } catch (e) {
      lastError = String((e && e.message) || e)
      log(`provider ${provider} 注册失败（代理端口仍然可用）：${lastError}`)
    }
    return { provider, models, adapter, error: lastError }
  }

  return {
    refresh,
    dispose,
    models: () => (lastModels.length || !getConfig() ? lastModels : providerModels(getConfig())),
    providerName,
    lastError: () => lastError,
    registeredAt: () => registeredAt,
    hasAdapter: () => !!disposeCurrent,
  }
}