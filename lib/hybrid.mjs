/**
 * 第五框架 `amd-hybrid` —— AMD NPU + GPU 双引擎协同层
 * ============================================================================
 *
 * 定位（契约 §4）：不是"再装一个引擎"，而是**组合框架**：
 *   - NPU 侧：FLM（AMD XDNA2，OpenAI 兼容，端口由 supervisor 分配）
 *   - GPU 侧：llama.cpp Vulkan（RDNA3.5 iGPU，OpenAI 兼容，同上）
 * 两个引擎都是插件自己的子进程、同一个 Job Object；对外仍然只有**一个** OpenAI
 * 端口、**一个** provider，调用方无感。
 *
 * 职责边界（重要）：
 *   - 本模块**不 spawn 任何进程**，也不 import supervisor。引擎拉起一律走
 *     `opts.ensureEngine(id)`（生产环境就是 `NpuSupervisor.ensure(slotId)`）。
 *     这样"进程都在 DSH 下面"这条硬约束天然成立，本模块只做编排。
 *   - 只用 fetch 打 `127.0.0.1:<slotPort>/v1/...`，非回环地址直接拒绝。
 *   - 配置的持久化不在这里做：`configure()` 通过 `opts.saveConfig`（生产环境是
 *     `lib/config.mjs` 的 `save()`）落盘，本模块不写任何文件。
 *
 * 四种模式（契约 §4）：
 *   route   按请求特征分流：embeddings / 翻译 → NPU；chat / 代码 / 长文 → GPU。
 *           单引擎失败自动换另一个；两个都不可用 → HybridError(status 503)。
 *   race    非流式：两引擎同时发，首个**完整**答案胜出，另一方 AbortController 取消。
 *           流式退化为 route（契约要求）。
 *   cascade 估算 prompt ≤ shortQueryTokens 先走 NPU；答案被截断（finish_reason=length）/
 *           拒答 / 空 / 复读 → 升级 GPU 重答。流式时先把首段"偷看"一眼（peekChars 个
 *           字符）再决定：已经吐出正文就不再升级；拒答在吐字之前仍可升级。
 *   augment NPU 先做前置增强（翻译成英文 / 摘要压缩 / 生成 embedding），把结果拼进
 *           GPU 的请求，一次请求内串联两引擎。
 *
 * 用法：
 *   const hybrid = createHybrid({
 *     config,                                   // 插件配置（读 config.hybrid）
 *     log,
 *     ensureEngine: (id) => sup.ensure(id === 'npu' ? npuSlot : gpuSlot),
 *     engineURL:    (id) => `http://127.0.0.1:${portOf(id)}/v1`,
 *     saveConfig:   (patch) => save(patch)      // 可选，configure() 用
 *   })
 *   await hybrid.chat({ messages, stream:false })
 *   await hybrid.embed({ input: 'hello' })
 *   await hybrid.bench({ prompt, maxTokens: 64 })
 */

export const HYBRID_MODES = ['auto', 'route', 'race', 'cascade', 'augment']

/** 两个引擎的固定 id。npu = FLM(XDNA2)，gpu = llama.cpp(Vulkan) */
export const HYBRID_ENGINES = ['npu', 'gpu']

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 内置默认值；真实值来自 config.hybrid（见契约 §2） */
const DEFAULTS = {
  enabled: true,
  mode: 'auto',
  // NPU 侧（FLM 模型 id）
  draftModel: 'qwen3.5:0.8b',
  // GPU 侧（gguf 文件名）
  verifyModel: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
  // NPU 侧的嵌入模型（FLM 的 alsoServes 别名）
  embedModel: 'embed-gemma:300m',
  // cascade：估算 prompt token ≤ 此值先走 NPU
  shortQueryTokens: 48,
  // race：决策预算；超时后取消较慢的一方（通常 NPU），保留 GPU 直到 requestTimeoutMs
  raceTimeoutMs: 12000,
  // 单次引擎请求的总超时
  requestTimeoutMs: 60000,
  // 流式：首 token 超时（也用作 cascade 偷看窗口）
  firstTokenTimeoutMs: 15000,
  // cascade 流式：偷看多少字符的正文才提交（不够就继续等，等不到就回退）
  peekChars: 24,
  // 低于这个字符数视为空答案
  minAnswerChars: 1,
  // augment：历史超过这么多估算 token 就先摘要压缩
  augmentMaxHistoryTokens: 700
}

export class HybridError extends Error {
  constructor(message, status = 500, extra = {}) {
    super(message)
    this.name = 'HybridError'
    this.status = status
    Object.assign(this, extra)
  }
}

/* ------------------------------------------------------------------ 工具 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR')
}

function linkSignals(signals) {
  const list = (signals || []).filter(Boolean)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list)
  }
  const ctrl = new AbortController()
  for (const s of list) {
    if (s.aborted) { ctrl.abort(); break }
    s.addEventListener('abort', () => { try { ctrl.abort() } catch { /* ignore */ } }, { once: true })
  }
  return ctrl.signal
}

/** 只允许回环地址：契约 §0.2（端口不得外泄） */
function assertLoopback(raw) {
  let u
  try {
    u = new URL(String(raw))
  } catch {
    throw new HybridError(`引擎地址无效：${raw}`, 500)
  }
  if (!/^https?:$/.test(u.protocol) || !LOOPBACK.has(u.hostname)) {
    throw new HybridError(`引擎地址必须是本机回环：${raw}`, 500)
  }
  return u.toString().replace(/\/+$/, '')
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f\uac00-\ud7af]/

/**
 * 估算 token 数：CJK 每字 ≈ 1 token，拉丁文 ≈ 4 字符 / token，
 * 每条消息 4 token 结构开销。故意与任何具体 tokenizer 解耦——
 * cascade 只需要一个量级判断，不需要精确。
 */
export function estimateTokens(text) {
  const s = String(text == null ? '' : text)
  if (!s) return 0
  let cjk = 0
  let latin = 0
  for (const ch of s) {
    if (CJK.test(ch)) cjk += 1
    else latin += 1
  }
  return cjk + Math.ceil(latin / 4)
}

export function estimateMessages(messages) {
  let total = 0
  for (const m of messages || []) {
    total += 4
    const c = m && m.content
    if (typeof c === 'string') total += estimateTokens(c)
    else if (Array.isArray(c)) for (const part of c) if (part && part.type === 'text') total += estimateTokens(part.text)
  }
  return total
}

export function messageText(messages) {
  const parts = []
  for (const m of messages || []) {
    const c = m && m.content
    if (typeof c === 'string') parts.push(c)
    else if (Array.isArray(c)) for (const p of c) if (p && p.type === 'text' && p.text) parts.push(p.text)
  }
  return parts.join('\n')
}

function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const t = c.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
      if (t) return t
    }
  }
  return ''
}

const CODE_HINTS = /(^|\n)\s*(```|function |class |def |const |let |import |from |SELECT |INSERT |package |public |private |npm |pip |git |docker )|<\/?[a-z][\w-]*>|=>|\bTODO\b|#include|^\s*[{[]/m
const TRANSLATE_HINT = /(translate|translation|翻译|译成|译为|翻成|target[_ -]?lang|to english|to chinese|英文|中文)/i
const REFUSAL = /^(抱歉|对不起|很抱歉|我无法|我不能|无法(回答|提供|协助|满足)|作为(一个)?(AI|人工智能|语言模型)|i (?:cannot|can't|can not|am unable|'m unable)|i'm sorry|sorry,? (?:but )?i|as an ai\b|unfortunately,? i)/i

/* -------------------------------------------------------------- 主体 */

/**
 * @param {{
 *   config?: any,
 *   log?: (msg: string, extra?: any) => void,
 *   ensureEngine: (id: 'npu'|'gpu') => Promise<any>,
 *   engineURL: (id: 'npu'|'gpu') => string | Promise<string>,
 *   fetchImpl?: typeof fetch,
 *   saveConfig?: (patch: any) => Promise<any> | any,
 *   onConfigure?: (hybrid: any) => any,
 *   now?: () => number
 * }} opts
 */
export function createHybrid(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()

  if (typeof opts.ensureEngine !== 'function') {
    throw new TypeError('createHybrid: 缺少 ensureEngine(id)（生产环境 = supervisor.ensure）')
  }
  if (typeof opts.engineURL !== 'function') {
    throw new TypeError('createHybrid: 缺少 engineURL(id)')
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createHybrid: 当前运行时没有 fetch')
  }

  let hybrid = normalizeHybrid(opts.config && opts.config.hybrid)
  let disposed = false
  /** 在飞的请求（可被 dispose() 一次性掐断） */
  const inflight = new Set()
  /** 引擎状态：只反映"最近一次已知"，status() 绝不主动拉起进程 */
  const engines = {
    npu: { id: 'npu', ready: false, model: hybrid.draftModel, lastErr: null, calls: 0 },
    gpu: { id: 'gpu', ready: false, model: hybrid.verifyModel, lastErr: null, calls: 0 }
  }
  let last = null

  /* -------------------------------------------------------- 配置 */

  function normalizeHybrid(src) {
    const raw = src && typeof src === 'object' ? src : {}
    const out = { ...DEFAULTS }
    for (const k of ['draftModel', 'verifyModel', 'embedModel']) {
      if (typeof raw[k] === 'string' && raw[k].trim()) out[k] = raw[k].trim()
    }
    if (HYBRID_MODES.includes(raw.mode)) out.mode = raw.mode
    if (raw.enabled === false) out.enabled = false
    else if (raw.enabled === true) out.enabled = true
    for (const k of ['shortQueryTokens', 'raceTimeoutMs', 'requestTimeoutMs', 'firstTokenTimeoutMs',
      'peekChars', 'minAnswerChars', 'augmentMaxHistoryTokens']) {
      const n = Number(raw[k])
      if (Number.isFinite(n) && n >= 0) out[k] = n
    }
    if (out.shortQueryTokens < 8) out.shortQueryTokens = 8
    if (out.raceTimeoutMs < 100) out.raceTimeoutMs = 100
    if (out.requestTimeoutMs < out.raceTimeoutMs) out.requestTimeoutMs = out.raceTimeoutMs
    return out
  }

  function syncEngineModels() {
    engines.npu.model = hybrid.draftModel
    engines.gpu.model = hybrid.verifyModel
  }

  async function configure(patch = {}) {
    const next = patch && patch.hybrid ? patch.hybrid : patch
    hybrid = normalizeHybrid({ ...hybrid, ...(next || {}) })
    syncEngineModels()
    log(`hybrid configure: mode=${hybrid.mode} enabled=${hybrid.enabled} short=${hybrid.shortQueryTokens}`)
    const snapshot = { ...hybrid }
    try {
      if (typeof opts.saveConfig === 'function') await opts.saveConfig({ hybrid: snapshot })
      else if (typeof opts.onConfigure === 'function') await opts.onConfigure(snapshot)
    } catch (err) {
      log(`hybrid configure 持久化失败：${err && err.message}`)
    }
    return snapshot
  }

  /* ------------------------------------------------------ 引擎接入 */

  function other(id) {
    return id === 'npu' ? 'gpu' : 'npu'
  }

  function modelFor(id) {
    return id === 'npu' ? hybrid.draftModel : hybrid.verifyModel
  }

  async function ensure(id) {
    if (disposed) throw new HybridError('hybrid 已 dispose', 503, { engine: id })
    const st = engines[id]
    try {
      const got = await opts.ensureEngine(id)
      st.ready = true
      st.lastErr = null
      return got
    } catch (err) {
      st.ready = false
      st.lastErr = String((err && err.message) || err)
      throw new HybridError(`引擎 ${id} 不可用：${st.lastErr}`, 503, { engine: id })
    }
  }

  async function baseURL(id) {
    await ensure(id)
    const raw = await opts.engineURL(id)
    if (!raw) throw new HybridError(`引擎 ${id} 没有端口`, 503, { engine: id })
    return assertLoopback(raw)
  }

  /** 组装发给某个引擎的 OpenAI body（剥掉 hybrid 自己的内部字段） */
  function buildBody(id, req, { stream }) {
    const src = req || {}
    const clean = {}
    for (const [k, v] of Object.entries(src)) {
      if (k === 'mode' || k === 'enhance' || k === 'augment' || k === 'endpoint' ||
        k === 'kind' || k === 'engine' || k === 'engineModel' || k === 'maxTokens') continue
      clean[k] = v
    }
    const body = { ...clean, model: resolveModel(id, src), stream: !!stream }
    if (!Array.isArray(body.messages)) {
      const prompt = typeof src.prompt === 'string' ? src.prompt : lastUserText(src.messages)
      body.messages = prompt ? [{ role: 'user', content: prompt }] : []
    }
    if (src.maxTokens != null) body.max_tokens = src.maxTokens
    if (stream) body.stream_options = { include_usage: true, ...(body.stream_options || {}) }
    return body
  }

  /**
   * 模型选择：调用方显式点名了两个引擎模型之一就用它，否则按引擎取
   * config.hybrid.draftModel / verifyModel。`model:'hybrid'` 这类占位名会被替换。
   */
  function resolveModel(id, req) {
    const m = req && typeof req.model === 'string' ? req.model : ''
    if (m && (m === hybrid.draftModel || m === hybrid.verifyModel)) return m
    if (m && m === hybrid.embedModel && id === 'npu') return m
    return modelFor(id)
  }

  /* ------------------------------------------------ 非流式单引擎请求 */

  async function callJSON(id, req, { signal, timeoutMs } = {}) {
    const url = await baseURL(id)
    const body = buildBody(id, req, { stream: false })
    const ctrl = new AbortController()
    const cancel = () => { try { ctrl.abort() } catch { /* ignore */ } }
    inflight.add(cancel)
    const timer = timeoutMs > 0
      ? setTimeout(() => { try { ctrl.abort(new Error(`引擎 ${id} 超时 ${timeoutMs}ms`)) } catch { /* ignore */ } }, timeoutMs)
      : null
    const linked = linkSignals([ctrl.signal, signal])
    const t0 = now()
    try {
      const res = await fetchImpl(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: linked
      })
      const ms = now() - t0
      if (!res.ok) {
        let detail = ''
        try { detail = (await res.text()).slice(0, 200) } catch { /* ignore */ }
        throw new HybridError(`引擎 ${id} 返回 HTTP ${res.status}${detail ? '：' + detail : ''}`,
          res.status === 503 ? 503 : 502, { engine: id })
      }
      const data = await res.json()
      engines[id].calls += 1
      engines[id].ready = true
      return { id, data, ms, firstTokenMs: ms, text: responseText(data), finish: finishOf(data), usage: data && data.usage }
    } catch (err) {
      if (engines[id]) engines[id].lastErr = String((err && err.message) || err)
      if (isAbortError(err)) throw new HybridError(`引擎 ${id} 请求被取消`, 499, { engine: id, aborted: true })
      if (err instanceof HybridError) throw err
      throw new HybridError(`引擎 ${id} 请求失败：${(err && err.message) || err}`, 502, { engine: id })
    } finally {
      if (timer) clearTimeout(timer)
      inflight.delete(cancel)
    }
  }

  function responseText(data) {
    const c = data && data.choices && data.choices[0]
    if (!c) return ''
    if (c.message && typeof c.message.content === 'string') return c.message.content
    if (typeof c.text === 'string') return c.text
    return ''
  }

  function finishOf(data) {
    const c = data && data.choices && data.choices[0]
    return c ? c.finish_reason || null : null
  }

  /** 质量判定：cascade 用它决定要不要升级 GPU */
  function looksBad(text, finish, req) {
    const t = String(text || '').trim()
    if (t.length < Math.max(1, hybrid.minAnswerChars || 1)) return { bad: true, why: 'empty' }
    if (finish === 'length') return { bad: true, why: 'truncated' }
    if (REFUSAL.test(t)) return { bad: true, why: 'refusal' }
    if (degenerate(t)) return { bad: true, why: 'degenerate' }
    return { bad: false, why: '' }
  }

  /** 复读 / 同一小段重复：cascade 的"明显低质"判定 */
  function degenerate(text) {
    if (text.length < 40) return false
    const uniq = new Set(text).size
    if (uniq / text.length < 0.06) return true
    const head = text.slice(0, 12)
    if (head && text.split(head).length - 1 >= 6) return true
    return false
  }

  /* --------------------------------------------------- 流式单引擎 */

  /**
   * 打开一个 SSE 流。返回 { engine, stream(AsyncGenerator<string>), meta, abort() }。
   * meta 会在消费过程中被填：firstTokenMs / text / tokens / usage / finish / totalMs。
   */
  async function openStream(id, req, { signal, timeoutMs } = {}) {
    const url = await baseURL(id)
    const body = buildBody(id, req, { stream: true })
    const ctrl = new AbortController()
    inflight.add(ctrl)
    const linked = linkSignals([ctrl.signal, signal])
    const t0 = now()
    const budget = timeoutMs > 0 ? timeoutMs : hybrid.firstTokenTimeoutMs
    const timer = budget > 0
      ? setTimeout(() => { try { ctrl.abort(new Error(`引擎 ${id} 首 token 超时`)) } catch { /* ignore */ } }, budget)
      : null

    let res
    try {
      res = await fetchImpl(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: linked
      })
    } catch (err) {
      if (timer) clearTimeout(timer)
      inflight.delete(ctrl)
      engines[id].lastErr = String((err && err.message) || err)
      if (isAbortError(err)) throw new HybridError(`引擎 ${id} 流式请求被取消`, 499, { engine: id, aborted: true })
      throw new HybridError(`引擎 ${id} 流式请求失败：${(err && err.message) || err}`, 502, { engine: id })
    }
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.text()).slice(0, 200) } catch { /* ignore */ }
      if (timer) clearTimeout(timer)
      inflight.delete(ctrl)
      try { ctrl.abort() } catch { /* ignore */ }
      throw new HybridError(`引擎 ${id} 返回 HTTP ${res.status}${detail ? '：' + detail : ''}`,
        res.status === 503 ? 503 : 502, { engine: id })
    }

    const meta = {
      engine: id,
      firstTokenMs: null,
      totalMs: null,
      text: '',
      tokens: 0,
      usage: null,
      finish: null,
      aborted: false
    }
    if (!res.body) {
      // 后端没按 SSE 回（一次性 JSON）：退化成单帧
      if (timer) clearTimeout(timer)
      let data = null
      try { data = await res.json() } catch { data = null }
      const text = responseText(data)
      meta.text = text
      meta.finish = finishOf(data)
      meta.usage = data && data.usage
      meta.tokens = (meta.usage && meta.usage.completion_tokens) || estimateTokens(text)
      if (text) meta.firstTokenMs = now() - t0
      meta.totalMs = now() - t0
      inflight.delete(ctrl)
      const frame = data ? `data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n` : ''
      engines[id].calls += 1
      const oneShot = async function* oneShotFrames() { if (frame) yield frame }
      return {
        engine: id,
        meta,
        abort() { /* 已经结束 */ },
        stream: oneShot()
      }
    }

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let raw = ''
    let closed = false

    /** 只做"记账"：清定时器、把自己从在飞集合里摘掉。真正的断连由 killCtrl 做 */
    function release() {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      inflight.delete(abortStream)
    }

    /** 断 TCP：必须在 reader.cancel() 之后调用，否则挂起的 read() 会以 AbortError 拒绝，
     *  而那个生成器可能已经没有人消费了 —— 会变成 unhandledRejection 打死宿主。 */
    function killCtrl() {
      try { ctrl.abort() } catch { /* ignore */ }
    }

    function abortStream() {
      meta.aborted = true
      release()
      try { reader.cancel().catch(() => {}) } catch { /* ignore */ }
      setImmediate(killCtrl)
    }

    inflight.add(abortStream)

    async function* frames() {
      try {
        let buf = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          const text = dec.decode(value, { stream: true })
          raw += text
          // 按完整行解析：delta 的 JSON 可能被切在两个 TCP 包里，逐块正则不可靠
          buf += text
          let nl = buf.indexOf('\n')
          while (nl >= 0) {
            trackLine(meta, buf.slice(0, nl))
            buf = buf.slice(nl + 1)
            nl = buf.indexOf('\n')
          }
          if (meta.firstTokenMs == null && meta.text.length > 0) {
            meta.firstTokenMs = now() - t0
            if (timer) clearTimeout(timer)
          }
          // 原样透传：上层代理不需要重新组帧
          yield text
        }
        if (buf) trackLine(meta, buf)
        meta.totalMs = now() - t0
        parseStreamTail(meta, raw)
      } catch (err) {
        meta.aborted = true
        // 主动取消（race 落败 / cascade 升级 / dispose / 消费方提前退出）：
        // 生成器可能已经没有人在消费，这里必须静默收尾
        if (isAbortError(err)) return
        throw new HybridError(`引擎 ${id} 流读取失败：${(err && err.message) || err}`, 502, { engine: id })
      } finally {
        meta.totalMs = meta.totalMs == null ? now() - t0 : meta.totalMs
        release()
        try { await reader.cancel() } catch { /* ignore */ }
        killCtrl()
      }
    }

    return {
      engine: id,
      meta,
      abort: abortStream,
      stream: frames()
    }
  }

  /** 解析一行 SSE：累积正文、usage、finish_reason */
  function trackLine(meta, line) {
    const t = String(line || '').trim()
    if (!t || t.charAt(0) === ':' || !t.startsWith('data:')) return
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let obj
    try { obj = JSON.parse(payload) } catch { return }
    if (obj.usage) meta.usage = obj.usage
    const c = obj.choices && obj.choices[0]
    if (!c) return
    if (c.finish_reason) meta.finish = c.finish_reason
    const d = c.delta || c.message || {}
    if (typeof d.content === 'string' && d.content) meta.text += d.content
  }

  function parseStreamTail(meta, raw) {
    if (!raw) return
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let obj
      try { obj = JSON.parse(payload) } catch { continue }
      if (obj.usage) meta.usage = obj.usage
      const c = obj.choices && obj.choices[0]
      if (c && c.finish_reason) meta.finish = c.finish_reason
    }
    if (meta.usage && meta.usage.completion_tokens) meta.tokens = meta.usage.completion_tokens
    else meta.tokens = estimateTokens(meta.text)
  }

  /* ------------------------------------------------------ 分类策略 */

  function isEmbeddingRequest(req) {
    if (!req) return false
    if (req.kind === 'embeddings' || req.endpoint === 'embeddings') return true
    if (Array.isArray(req.input) || typeof req.input === 'string') return true
    return false
  }

  function isTranslation(req) {
    const model = String((req && req.model) || '')
    if (/translat|hy-mt|mt-flash|:mt\b/i.test(model)) return true
    if (req && (req.target_lang || req.targetLang || req.to)) return true
    const text = messageText(req && req.messages)
    if (!text) return false
    const short = estimateTokens(text) <= Math.max(hybrid.shortQueryTokens * 3, 160)
    if (!short) return false
    // 显式让翻译，或者"系统提示里出现翻译 + 正文是另一种语言"这类常见形态
    return TRANSLATE_HINT.test(text)
  }

  /**
   * route 的判据（可在 status().last.reason 里解释给用户）：
   *   翻译 / 嵌入 → NPU；代码 / 长文 / 通用 chat → GPU。
   */
  function classify(req) {
    if (isEmbeddingRequest(req)) return { engine: 'npu', reason: 'embedding' }
    if (isTranslation(req)) return { engine: 'npu', reason: 'translation' }
    const text = messageText(req && req.messages)
    const tokens = estimateMessages(req && req.messages)
    if (CODE_HINTS.test(text)) return { engine: 'gpu', reason: 'code' }
    if (tokens > Math.max(hybrid.shortQueryTokens * 4, 400)) return { engine: 'gpu', reason: 'long' }
    return { engine: 'gpu', reason: 'chat' }
  }

  /** auto：短请求非流式 → cascade（先 NPU 试一把最省电），其余按 route */
  function pickMode(req) {
    const explicit = req && HYBRID_MODES.includes(req.mode) && req.mode !== 'auto' ? req.mode : null
    if (explicit) return explicit
    if (hybrid.mode && hybrid.mode !== 'auto') return hybrid.mode
    if (isEmbeddingRequest(req)) return 'route'
    if (isTranslation(req)) return 'route'
    if (!req.stream && estimateMessages(req.messages) <= hybrid.shortQueryTokens) return 'cascade'
    return 'route'
  }

  /* -------------------------------------------------- route 模式 */

  async function routeCall(req, { mode = 'route', signal } = {}) {
    const decision = classify(req)
    const order = [decision.engine, other(decision.engine)]
    const attempts = []
    const t0 = now()
    for (const id of order) {
      try {
        const r = await callJSON(id, req, { signal, timeoutMs: hybrid.requestTimeoutMs })
        attempts.push({ engine: id, ok: true, ms: r.ms })
        const engine = attempts.length > 1 ? 'hybrid' : id
        return settle(engine, r, {
          mode, reason: decision.reason, attempts, fallback: attempts.length > 1, t0,
          firstChoice: decision.engine, finalEngine: id
        })
      } catch (err) {
        attempts.push({ engine: id, ok: false, ms: now() - t0, error: String((err && err.message) || err) })
        log(`hybrid route ${id} 失败，尝试 ${other(id)}：${(err && err.message) || err}`)
      }
    }
    throw bothFailed(mode, attempts)
  }

  function bothFailed(mode, attempts) {
    return new HybridError(
      `混合推理：NPU 与 GPU 都不可用（${mode}）。请检查 FLM / llama.cpp 是否安装、模型是否就绪。`,
      503,
      { attempts }
    )
  }

  function settle(engine, r, extra) {
    const totalMs = now() - extra.t0
    const winner = extra.finalEngine || (engine === 'hybrid' ? (extra.winnerEngine || null) : engine)
    const timings = {
      mode: extra.mode,
      engine,
      reason: extra.reason,
      firstTokenMs: r.firstTokenMs,
      totalMs,
      attempts: extra.attempts,
      fallback: !!extra.fallback,
      firstChoice: extra.firstChoice,
      escalated: !!extra.escalated,
      winner,
      aborted: false
    }
    const out = { engine, mode: extra.mode, body: r.data, text: r.text, timings }
    if (extra.escalated) out.escalated = true
    last = { mode: extra.mode, engine, winner, ms: totalMs, at: new Date().toISOString() }
    return out
  }

  /* --------------------------------------------------- race 模式 */

  /**
   * 非流式竞速：两引擎同时发，首个**完整**答案胜出，另一方 AbortController 取消。
   * 决策预算 raceTimeoutMs：超时后取消较慢的一方（通常是 NPU），保留 GPU 到总超时。
   */
  async function raceCall(req, { signal } = {}) {
    const t0 = now()
    const attempts = []
    const result = await new Promise((resolve, reject) => {
      let settled = false
      let failed = 0
      const ctls = {}
      const timers = []
      const hardTimer = setTimeout(() => {
        // 整体超时：两边一起掐
        if (settled) return
        settleFail(new HybridError(`混合推理：race 在 ${hybrid.requestTimeoutMs}ms 内没有引擎返回完整答案`, 503, { attempts }))
      }, hybrid.requestTimeoutMs)
      const softTimer = setTimeout(() => {
        // 决策预算用完：只掐 NPU（0.8B 草稿引擎，TPS 低、答案质量也弱），
        // 把预算让给 GPU 拿完整答案；GPU 还有 requestTimeoutMs 兜底。
        // 反过来"两边一起掐"会让尾延迟优化变成尾延迟灾难（实测过）。
        const c = ctls.npu
        if (c && !c.done) {
          c.slow = true
          log(`hybrid race: ${hybrid.raceTimeoutMs}ms 内 NPU 没回完整答案，取消它，等 GPU`)
          try { c.ctrl.abort(new Error('race 决策预算超时')) } catch { /* ignore */ }
        }
      }, hybrid.raceTimeoutMs)

      function cleanup() {
        clearTimeout(hardTimer)
        clearTimeout(softTimer)
        for (const t of timers) clearTimeout(t)
      }

      function settleOk(win) {
        if (settled) return
        settled = true
        for (const id of HYBRID_ENGINES) {
          const c = ctls[id]
          if (!c || c.done) continue
          c.aborted = true
          try { c.ctrl.abort(new Error('race 落败，取消')) } catch { /* ignore */ }
        }
        cleanup()
        resolve(win)
      }

      function settleFail(err) {
        if (settled) return
        settled = true
        cleanup()
        for (const id of HYBRID_ENGINES) {
          const c = ctls[id]
          if (c && !c.done) { try { c.ctrl.abort(new Error('race 失败')) } catch { /* ignore */ } }
        }
        reject(err)
      }

      for (const id of HYBRID_ENGINES) {
        const c = { ctrl: new AbortController(), done: false, slow: false, aborted: false }
        ctls[id] = c
        const attempt = callJSON(id, req, { signal: linkSignals([c.ctrl.signal, signal]), timeoutMs: hybrid.requestTimeoutMs })
        attempt.then((r) => {
          c.done = true
          attempts.push({ engine: id, ok: true, ms: now() - t0 })
          settleOk({ engine: 'hybrid', winner: id, r, t0, attempts, aborted: c.aborted, slow: c.slow })
        }).catch((err) => {
          c.done = true
          attempts.push({
            engine: id, ok: false, ms: now() - t0,
            aborted: !!c.aborted, slow: !!c.slow,
            error: String((err && err.message) || err)
          })
          if (c.aborted && settled) return
          failed += 1
          if (failed === HYBRID_ENGINES.length) settleFail(bothFailed('race', attempts))
        })
      }
    })

    const timings = {
      mode: 'race',
      engine: 'hybrid',
      winner: result.winner,
      loser: other(result.winner),
      firstTokenMs: result.r.firstTokenMs,
      totalMs: now() - result.t0,
      attempts: result.attempts,
      aborted: result.aborted,
      escalated: false
    }
    last = { mode: 'race', engine: 'hybrid', winner: result.winner, ms: timings.totalMs, at: new Date().toISOString() }
    return { engine: 'hybrid', mode: 'race', winner: result.winner, body: result.r.data, text: result.r.text, timings }
  }

  /* ------------------------------------------------ cascade 模式 */

  async function cascadeCall(req, { signal } = {}) {
    const t0 = now()
    const tokens = estimateMessages(req.messages)
    const attempts = []
    if (tokens > hybrid.shortQueryTokens) {
      const r = await callJSON('gpu', req, { signal, timeoutMs: hybrid.requestTimeoutMs })
      attempts.push({ engine: 'gpu', ok: true, ms: r.ms })
      return settle('gpu', r, { mode: 'cascade', reason: 'long-prompt', attempts, t0, firstChoice: 'gpu' })
    }

    let first = null
    try {
      first = await callJSON('npu', req, { signal, timeoutMs: hybrid.requestTimeoutMs })
      attempts.push({ engine: 'npu', ok: true, ms: first.ms })
    } catch (err) {
      attempts.push({ engine: 'npu', ok: false, ms: now() - t0, error: String((err && err.message) || err) })
      log(`hybrid cascade: NPU 失败，直接升级 GPU（${(err && err.message) || err}）`)
    }

    if (first) {
      const verdict = looksBad(first.text, first.finish, req)
      if (!verdict.bad) {
        return settle('npu', first, { mode: 'cascade', reason: 'short-prompt', attempts, t0, firstChoice: 'npu' })
      }
      log(`hybrid cascade: NPU 答案不合格（${verdict.why}），升级 GPU 重答`)
      attempts[attempts.length - 1].rejected = verdict.why
    }

    const gpu = await callJSON('gpu', req, { signal, timeoutMs: hybrid.requestTimeoutMs })
    attempts.push({ engine: 'gpu', ok: true, ms: gpu.ms })
    return settle('hybrid', gpu, {
      mode: 'cascade', reason: first ? 'escalate' : 'npu-down', attempts, t0,
      firstChoice: 'npu', escalated: true, finalEngine: 'gpu'
    })
  }

  /**
   * 流式 cascade：先起 NPU 流，偷看 peekChars 个正文字符再决定。
   *  - 偷到合格正文 → 提交，回 NPU（之后截断也不再升级，契约要求）
   *  - 偷到拒答/空 → 掐掉 NPU，改用 GPU（此刻还没吐出任何 token）
   *  - NPU 起不来/超时 → GPU
   */
  async function cascadeStream(req, { signal } = {}) {
    const t0 = now()
    const tokens = estimateMessages(req.messages)
    const attempts = []
    if (tokens > hybrid.shortQueryTokens) {
      const s = await openStream('gpu', req, { signal })
      attempts.push({ engine: 'gpu', ok: true })
      return streamResult(s, {
        mode: 'cascade', reason: 'long-prompt', attempts, t0, firstChoice: 'gpu'
      })
    }

    let npu = null
    try {
      npu = await openStream('npu', req, { signal })
      attempts.push({ engine: 'npu', ok: true })
    } catch (err) {
      attempts.push({ engine: 'npu', ok: false, error: String((err && err.message) || err) })
      log(`hybrid cascade(stream): NPU 失败，改 GPU（${(err && err.message) || err}）`)
    }

    if (npu) {
      const peek = await peekStream(npu, hybrid.peekChars)
      if (!peek.bad) {
        return streamResult(peekStreamResult(npu, peek), {
          mode: 'cascade', reason: 'short-prompt', attempts, t0, firstChoice: 'npu'
        })
      }
      log(`hybrid cascade(stream): NPU 首段不合格（${peek.why}），升级 GPU`)
      attempts[attempts.length - 1].rejected = peek.why
      npu.abort()
    }

    const gpu = await openStream('gpu', req, { signal })
    attempts.push({ engine: 'gpu', ok: true })
    return streamResult(gpu, {
      mode: 'cascade', reason: 'escalate', attempts, t0, firstChoice: 'npu', escalated: true
    })
  }

  /** 偷看：拿到 peekChars 个正文字符、流结束、或超时为止 */
  async function peekStream(handle, peekChars) {
    const iter = handle.stream[Symbol.asyncIterator]()
    const buffered = []
    const want = Math.max(4, peekChars)
    let why = 'pending'
    try {
      while (true) {
        const { value, done } = await iter.next()
        if (done) { why = handle.meta.text.length ? 'ended' : 'empty'; break }
        if (value) buffered.push(value)
        if (handle.meta.text.length >= want) { why = 'peeked'; break }
        if (REFUSAL.test(handle.meta.text.trim()) && handle.meta.text.trim().length >= 6) {
          why = 'refusal'
          break
        }
      }
    } catch (err) {
      why = isAbortError(err) ? 'abort' : 'error'
      buffered.length = 0
    }
    const text = handle.meta.text.trim()
    const bad = why === 'empty' || why === 'error' || why === 'abort' ||
      (why === 'refusal') || (why === 'ended' && text.length < 1) ||
      (why === 'ended' && REFUSAL.test(text))
    return { bad, why, buffered, iter, text }
  }

  function peekStreamResult(handle, peek) {
    const iter = peek.iter
    const buffered = peek.buffered.slice()
    const meta = handle.meta
    const combined = async function* combinedFrames() {
      try {
        for (const f of buffered) yield f
        while (true) {
          const { value, done } = await iter.next()
          if (done) break
          yield value
        }
      } finally {
        handle.abort()
      }
    }
    return {
      engine: 'npu',
      meta,
      abort() { handle.abort() },
      stream: combined()
    }
  }

  function streamResult(handle, extra) {
    const timings = {
      mode: extra.mode,
      engine: extra.engine || handle.engine,
      reason: extra.reason,
      firstTokenMs: null,
      totalMs: null,
      attempts: extra.attempts,
      fallback: !!extra.fallback,
      firstChoice: extra.firstChoice,
      escalated: !!extra.escalated,
      winner: handle.engine,
      aborted: false
    }
    const meta = handle.meta
    const result = {
      engine: extra.escalated ? 'hybrid' : handle.engine,
      mode: extra.mode,
      stream: handle.stream,
      timings,
      meta,
      abort: () => handle.abort()
    }
    if (extra.escalated) result.escalated = true
    last = { mode: extra.mode, engine: result.engine, winner: handle.engine, at: new Date().toISOString() }
    // 让 timings 跟着流走：消费方读到的就是最终值
    const proxy = async function* () {
      try {
        yield* handle.stream
      } finally {
        timings.firstTokenMs = meta.firstTokenMs
        timings.totalMs = meta.totalMs
        timings.tokens = meta.tokens
        timings.finish = meta.finish
        timings.engine = handle.engine
        timings.aborted = meta.aborted
      }
    }
    result.stream = proxy()
    return result
  }

  /* -------------------------------------------------- augment 模式 */

  function pickEnhance(req) {
    const want = req && (req.enhance || req.augment)
    if (typeof want === 'string') return [want]
    if (Array.isArray(want)) return want
    if (want && typeof want === 'object') return Array.isArray(want.steps) ? want.steps : ['auto']
    return ['auto']
  }

  function planSteps(req) {
    const want = pickEnhance(req)
    const steps = []
    const historyTokens = estimateMessages((req.messages || []).slice(0, -1))
    for (let step of want) {
      if (step === 'auto') {
        if (historyTokens >= hybrid.augmentMaxHistoryTokens) step = 'summary'
        else {
          const user = lastUserText(req.messages)
          step = CJK.test(user) && user.length > 0 ? 'translate' : 'none'
        }
      }
      if (step === 'none') continue
      if (!steps.includes(step)) steps.push(step)
    }
    return steps
  }

  async function npuText(prompt, { signal, timeoutMs } = {}) {
    const r = await callJSON('npu', {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 512
    }, { signal, timeoutMs: timeoutMs || hybrid.requestTimeoutMs })
    return String(r.text || '').trim()
  }

  async function npuEmbed(input, { signal } = {}) {
    const url = await baseURL('npu')
    const body = { model: hybrid.embedModel, input }
    const ctrl = new AbortController()
    inflight.add(ctrl)
    const timer = setTimeout(() => {
      try { ctrl.abort(new Error('embedding 超时')) } catch { /* ignore */ }
    }, hybrid.requestTimeoutMs)
    try {
      const res = await fetchImpl(`${url}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: linkSignals([ctrl.signal, signal])
      })
      if (!res.ok) throw new HybridError(`NPU embedding 返回 HTTP ${res.status}`, 502)
      const data = await res.json()
      const vectors = (data && data.data ? data.data : []).map((d) => d.embedding)
      engines.npu.calls += 1
      return { vectors, body: data }
    } finally {
      clearTimeout(timer)
      inflight.delete(ctrl)
    }
  }

  async function augmentCall(req, { signal, streaming } = {}) {
    const t0 = now()
    const steps = planSteps(req)
    const augment = { steps, npuMs: 0, skipped: null, translated: null, summary: null, embedding: null }
    const outReq = { ...req, messages: (req.messages || []).map((m) => ({ ...m })) }
    const attempts = []

    for (const step of steps) {
      try {
        if (step === 'translate') {
          const src = lastUserText(req.messages)
          if (!src) { augment.skipped = 'empty-prompt'; continue }
          const s0 = now()
          const en = await npuText(
            `Translate the following user message into English. Output ONLY the translation, no explanation.\n\n${src}`,
            { signal }
          )
          augment.npuMs += now() - s0
          if (!en) { augment.skipped = 'translate-empty'; continue }
          augment.translated = en
          replaceLastUserContent(outReq, en)
          // 让 GPU 用用户原本的语言作答（DPO 里常见的"借英文推理、按原语言回话"）
          pushSystemNote(outReq, 'The user message was translated to English for reasoning. Answer in the same language the user originally used.')
        } else if (step === 'summary') {
          const history = (req.messages || []).slice(0, -1)
          const last = (req.messages || []).slice(-1)
          if (!history.length) { augment.skipped = 'no-history'; continue }
          const s0 = now()
          const digest = await npuText(
            `Compress the following conversation into a terse English brief (facts, decisions, open questions). Keep under 150 words.\n\n${messageText(history)}`,
            { signal }
          )
          augment.npuMs += now() - s0
          if (!digest) { augment.skipped = 'summary-empty'; continue }
          augment.summary = digest
          outReq.messages = [{ role: 'system', content: `Conversation brief:\n${digest}` }, ...last]
        } else if (step === 'embed') {
          const q = lastUserText(req.messages) || messageText(req.messages)
          if (!q) { augment.skipped = 'embed-empty'; continue }
          const s0 = now()
          const { vectors } = await npuEmbed(q, { signal })
          augment.npuMs += now() - s0
          augment.embedding = vectors
          // 拼进 GPU 请求：把语义指纹的维度与前几个分量摘要给 GPU 做"检索上下文"占位；
          // 真正的检索命中由调用方在 req.retrievedText 里给。
          if (req && req.retrievedText) pushSystemNote(outReq, `Retrieved context:\n${req.retrievedText}`)
        } else {
          augment.skipped = `unknown-step:${step}`
        }
        attempts.push({ step, ok: true })
      } catch (err) {
        attempts.push({ step, ok: false, error: String((err && err.message) || err) })
        augment.skipped = augment.skipped || `${step}-failed`
        log(`hybrid augment: ${step} 失败，降级为直连 GPU（${(err && err.message) || err}）`)
        break
      }
    }
    augment.attempts = attempts
    augment.totalMs = now() - t0

    if (streaming) {
      const s = await openStream('gpu', outReq, { signal })
      const res = streamResult(s, {
        mode: 'augment',
        reason: augment.steps.length ? 'augmented' : 'passthrough',
        attempts: [{ engine: 'npu', ok: !!augment.steps.length }, { engine: 'gpu', ok: true }],
        t0, firstChoice: 'npu', escalated: augment.steps.length > 0
      })
      res.augment = augment
      return res
    }

    const gpu = await callJSON('gpu', outReq, { signal, timeoutMs: hybrid.requestTimeoutMs })
    const engine = augment.steps.length && !augment.skipped ? 'hybrid' : 'gpu'
    const out = settle(engine, gpu, {
      mode: 'augment',
      reason: augment.steps.length ? 'augmented' : 'passthrough',
      attempts: [...attempts.map((a) => ({ engine: 'npu', ok: a.ok, step: a.step, error: a.error })), { engine: 'gpu', ok: true, ms: gpu.ms }],
      t0, firstChoice: 'npu', escalated: engine === 'hybrid', finalEngine: 'gpu'
    })
    out.augment = augment
    return out
  }

  function replaceLastUserContent(req, content) {
    const msgs = req.messages || []
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i] && msgs[i].role === 'user') {
        msgs[i] = { role: 'user', content }
        return
      }
    }
    msgs.push({ role: 'user', content })
  }

  function pushSystemNote(req, note) {
    req.messages = [{ role: 'system', content: note }, ...(req.messages || [])]
  }

  /* ------------------------------------------------------ 对外接口 */

  async function chat(req = {}) {
    if (disposed) throw new HybridError('hybrid 已 dispose', 503)
    const mode = pickMode(req)
    const streaming = req.stream === true
    log(`hybrid chat: mode=${mode} stream=${streaming}`)

    if (isEmbeddingRequest(req) && !streaming) return embed(req)

    if (mode === 'route') {
      if (streaming) return routeStream(req)
      return routeCall(req, { mode: 'route' })
    }

    if (mode === 'race') {
      if (streaming) {
        // 契约：race 只对非流式生效，流式退化为 route
        const out = await routeStream(req)
        out.timings.degradedFrom = 'race'
        return out
      }
      return raceCall(req)
    }

    if (mode === 'cascade') {
      if (streaming) return cascadeStream(req)
      return cascadeCall(req)
    }

    if (mode === 'augment') return augmentCall(req, { streaming })

    throw new HybridError(`未知的混合模式：${mode}`, 400)
  }

  async function routeStream(req, { signal } = {}) {
    const decision = classify(req)
    const order = [decision.engine, other(decision.engine)]
    const attempts = []
    const t0 = now()
    for (const id of order) {
      try {
        const s = await openStream(id, req, { signal })
        attempts.push({ engine: id, ok: true })
        return streamResult(s, {
          mode: 'route', engine: id, reason: decision.reason, attempts, t0,
          firstChoice: decision.engine, fallback: attempts.length > 1
        })
      } catch (err) {
        attempts.push({ engine: id, ok: false, error: String((err && err.message) || err) })
        log(`hybrid route(stream) ${id} 失败，尝试 ${other(id)}：${(err && err.message) || err}`)
      }
    }
    throw bothFailed('route.stream', attempts)
  }

  async function embed(req = {}) {
    const input = req.input != null ? req.input : messageText(req.messages)
    const t0 = now()
    const attempts = []
    for (const id of ['npu', 'gpu']) {
      try {
        let out
        if (id === 'npu') {
          out = await npuEmbed(input, { signal: req.signal })
        } else {
          const url = await baseURL('gpu')
          const ctrl = new AbortController()
          inflight.add(ctrl)
          try {
            const res = await fetchImpl(`${url}/embeddings`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model: modelFor('gpu'), input }),
              signal: ctrl.signal
            })
            if (!res.ok) throw new HybridError(`GPU embedding 返回 HTTP ${res.status}`, 502)
            const data = await res.json()
            out = { vectors: (data && data.data ? data.data : []).map((d) => d.embedding), body: data }
          } finally {
            inflight.delete(ctrl)
          }
        }
        attempts.push({ engine: id, ok: true })
        const ms = now() - t0
        last = { mode: 'route', engine: id, kind: 'embedding', ms, at: new Date().toISOString() }
        return {
          engine: id,
          mode: 'route',
          vectors: out.vectors,
          body: out.body,
          timings: { mode: 'route', engine: id, reason: 'embedding', firstTokenMs: ms, totalMs: ms, attempts, escalated: false }
        }
      } catch (err) {
        attempts.push({ engine: id, ok: false, error: String((err && err.message) || err) })
      }
    }
    throw bothFailed('embed', attempts)
  }

  /* --------------------------------------------------------- bench */

  /**
   * 基准：同一 prompt、同一 maxTokens，分别跑 npu / gpu / hybrid 四种模式。
   * 直连引擎的行用流式测真实首 token；race 是非流式（契约），其 firstTokenMs 即总耗时。
   */
  async function bench({ prompt, maxTokens = 64, runs = 3, stream } = {}) {
    if (disposed) throw new HybridError('hybrid 已 dispose', 503)
    const p = typeof prompt === 'string' && prompt.trim()
      ? prompt
      : '用三句话说明为什么"进程都在宿主进程树下"对本地推理很重要。'
    const n = Math.max(1, Math.min(10, Number(runs) || 3))
    const rows = []
    let accept = 0
    let cascadeRuns = 0

    // 直连两引擎（流式，能测到真实首 token）
    for (const id of HYBRID_ENGINES) {
      const row = { engine: id, mode: 'direct', tokps: 0, firstTokenMs: 0, totalMs: 0, runs: n, samples: [] }
      for (let i = 0; i < n; i += 1) {
        try {
          row.samples.push(await chatDirect(id, p, maxTokens))
        } catch (err) {
          row.samples.push({ error: String((err && err.message) || err) })
        }
        await sleep(120)
      }
      summarise(row)
      rows.push(row)
    }

    // 混合模式
    const modes = ['route', 'cascade', 'race', 'augment']
    for (const mode of modes) {
      const row = { engine: 'hybrid', mode, tokps: 0, firstTokenMs: 0, totalMs: 0, runs: n, samples: [], escalated: 0 }
      for (let i = 0; i < n; i += 1) {
        const useStream = stream != null ? !!stream : mode !== 'race'
        const t0 = now()
        try {
          if (useStream) {
            const res = await chat({ messages: [{ role: 'user', content: p }], mode, stream: true, maxTokens })
            const consumed = await drainStream(res)
            row.samples.push(consumed)
            if (mode === 'cascade') {
              cascadeRuns += 1
              if (!res.escalated) accept += 1
            }
            if (res.escalated) row.escalated += 1
          } else {
            const res = await chat({ messages: [{ role: 'user', content: p }], mode, stream: false, maxTokens })
            const usage = (res.body && res.body.usage) || {}
            const outTokens = usage.completion_tokens || estimateTokens(res.text)
            const totalMs = now() - t0
            row.samples.push({
              engine: res.engine, winner: res.timings && res.timings.winner,
              firstTokenMs: res.timings && res.timings.firstTokenMs ? res.timings.firstTokenMs : totalMs,
              totalMs, tokens: outTokens, tokps: totalMs > 0 ? outTokens / (totalMs / 1000) : 0
            })
            if (mode === 'cascade') {
              cascadeRuns += 1
              if (!res.escalated) accept += 1
            }
            if (res.escalated) row.escalated += 1
          }
        } catch (err) {
          row.samples.push({ error: String((err && err.message) || err) })
        }
        await sleep(120)
      }
      summarise(row)
      rows.push(row)
    }

    const acceptRate = cascadeRuns > 0 ? Number((accept / cascadeRuns).toFixed(3)) : undefined
    return { ok: true, prompt: p, maxTokens, runs: n, rows, acceptRate, at: new Date().toISOString() }
  }

  /** 用指定引擎直接开流（bench 用；绕过 classify，确保"直连 NPU / 直连 GPU"是真直连） */
  async function chatDirect(id, prompt, maxTokens) {
    const t0 = now()
    const s = await openStream(id, { messages: [{ role: 'user', content: prompt }], maxTokens }, {})
    let tokens = 0
    let first = null
    let textLen = 0
    try {
      for await (const frame of s.stream) {
        if (first == null && s.meta.text.length) first = s.meta.firstTokenMs
      }
    } finally {
      s.abort()
    }
    const totalMs = now() - t0
    tokens = s.meta.tokens || estimateTokens(s.meta.text)
    textLen = s.meta.text.length
    return {
      engine: id,
      firstTokenMs: s.meta.firstTokenMs == null ? null : s.meta.firstTokenMs,
      totalMs,
      tokens,
      textLen,
      finish: s.meta.finish,
      tokps: totalMs > 0 ? tokens / (totalMs / 1000) : 0
    }
  }

  async function drainStream(res) {
    const t0 = now()
    let frames = 0
    let chars = 0
    try {
      for await (const frame of res.stream) {
        frames += 1
        chars += frame.length
      }
    } catch (err) {
      return {
        engine: res.meta && res.meta.engine,
        error: String((err && err.message) || err),
        timings: res.timings
      }
    }
    const meta = res.meta || {}
    const totalMs = now() - t0
    const firstTokenMs = res.timings.firstTokenMs != null ? res.timings.firstTokenMs : (meta.firstTokenMs == null ? totalMs : meta.firstTokenMs)
    const tokens = res.timings.tokens || meta.tokens || estimateTokens(meta.text)
    return {
      engine: res.timings.engine || (meta && meta.engine),
      escalated: !!res.escalated,
      firstTokenMs,
      totalMs,
      tokens,
      tokps: totalMs > 0 ? tokens / (totalMs / 1000) : 0,
      frames,
      chars,
      finish: meta.finish
    }
  }

  function summarise(row) {
    const ok = row.samples.filter((s) => s && !s.error && Number.isFinite(s.tokps))
    if (!ok.length) {
      row.tokps = 0
      row.firstTokenMs = 0
      row.totalMs = 0
      row.errors = row.samples.filter((s) => s && s.error).length
      return
    }
    row.tokps = Number((ok.reduce((a, s) => a + s.tokps, 0) / ok.length).toFixed(2))
    const ft = ok.filter((s) => s.firstTokenMs != null)
    row.firstTokenMs = ft.length ? Math.round(ft.reduce((a, s) => a + s.firstTokenMs, 0) / ft.length) : 0
    row.totalMs = Math.round(ok.reduce((a, s) => a + s.totalMs, 0) / ok.length)
    row.ok = ok.length
    row.errors = row.samples.length - ok.length
    row.p50 = {
      tokps: Number(median(ok.map((s) => s.tokps)).toFixed(2)),
      firstTokenMs: Math.round(median(ok.filter((s) => s.firstTokenMs != null).map((s) => s.firstTokenMs))),
      totalMs: Math.round(median(ok.map((s) => s.totalMs)))
    }
  }

  /* ------------------------------------------------------- status */

  function status() {
    syncEngineModels()
    return {
      enabled: hybrid.enabled,
      mode: hybrid.mode,
      modes: HYBRID_MODES.slice(),
      engines: HYBRID_ENGINES.map((id) => ({
        id,
        ready: !!engines[id].ready,
        model: modelFor(id),
        calls: engines[id].calls,
        lastError: engines[id].lastErr
      })),
      last,
      policy: {
        shortQueryTokens: hybrid.shortQueryTokens,
        raceTimeoutMs: hybrid.raceTimeoutMs,
        requestTimeoutMs: hybrid.requestTimeoutMs,
        firstTokenTimeoutMs: hybrid.firstTokenTimeoutMs,
        augmentMaxHistoryTokens: hybrid.augmentMaxHistoryTokens
      }
    }
  }

  function dispose() {
    disposed = true
    for (const c of inflight) {
      // inflight 里既有 AbortController（单次请求），也有 abortStream 回调（流式），统一处理
      try {
        if (typeof c === 'function') c()
        else if (c && typeof c.abort === 'function') c.abort(new Error('hybrid dispose'))
      } catch { /* ignore */ }
    }
    inflight.clear()
  }

  return {
    // 契约 §4
    status,
    configure,
    chat,
    embed,
    bench,
    dispose,
    // 便于测试/诊断的附加出口
    classify,
    estimate: { tokens: estimateTokens, messages: estimateMessages }
  }
}

function median(list) {
  const arr = (list || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!arr.length) return 0
  const mid = Math.floor(arr.length / 2)
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2
}