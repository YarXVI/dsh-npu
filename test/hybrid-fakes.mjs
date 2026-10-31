/**
 * 混合框架测试用的假 OpenAI 服务 + 装配器（离线，不依赖真模型 / 真 NPU）
 *
 * 设计目标：能精确控制「什么时候回、回什么、回一半被 abort」，用来验证
 * route / race / cascade / augment 四种编排逻辑，以及超时与取消是否真的掐断。
 */
import http from 'node:http'
import { createHybrid } from '../lib/hybrid.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 把一个长文本切成若干 SSE delta 帧 */
export function splitText(text, size = 8) {
  const out = []
  const s = String(text || '')
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out.length ? out : ['']
}

/**
 * 起一个假引擎。
 * @param {string} name  'npu' | 'gpu' | 任意
 * @param {(kind:'chat'|'embeddings', body:any, state:any) => any} resolve
 *        返回 { status?, message?, text?, finish?, tokens?, chunks?, chunkDelayMs?, hangMs?, vectors? }
 */
export async function startFakeEngine(name, resolve = () => ({})) {
  const state = {
    name,
    requests: [],
    chatCalls: 0,
    embedCalls: 0,
    aborted: 0,
    closed: false,
    closedSockets: 0
  }

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const url = String(req.url || '').split('?')[0]
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch { body = {} }
      state.requests.push({ url, body, at: Date.now() })
      const kind = url.endsWith('/embeddings') ? 'embeddings' : 'chat'
      if (kind === 'chat') state.chatCalls += 1
      else state.embedCalls += 1

      // 客户端中途放弃（race 落败 / cascade 升级 / dispose）会走到这里
      res.on('close', () => {
        if (!res.writableFinished) state.aborted += 1
      })

      let plan = {}
      try { plan = (await resolve(kind, body, state)) || {} } catch (err) {
        plan = { status: 500, message: String((err && err.message) || err) }
      }

      if (plan.status && Number(plan.status) !== 200) {
        res.writeHead(Number(plan.status), { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: plan.message || 'fake engine error' } }))
        return
      }

      if (plan.hangMs) {
        await sleep(plan.hangMs)
        if (res.destroyed || state.closed) return
      }

      if (kind === 'embeddings') {
        const vectors = plan.vectors || [[0.1, 0.2, 0.3]]
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: vectors.map((v, i) => ({ object: 'embedding', index: i, embedding: v })),
          usage: { prompt_tokens: 3, total_tokens: 3 }
        }))
        return
      }

      const chunks = plan.chunks || splitText(plan.text == null ? `${name}:ok` : plan.text, plan.chunkSize || 8)
      const tokens = plan.tokens == null ? chunks.length : plan.tokens

      if (body.stream || plan.forceStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`)
        for (const ch of chunks) {
          if (plan.chunkDelayMs) await sleep(plan.chunkDelayMs)
          if (res.writableEnded || res.destroyed) { state.aborted += 1; return }
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: ch } }] })}\n\n`)
        }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: plan.finish || 'stop' }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: tokens, total_tokens: 5 + tokens } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `fake-${name}`,
        object: 'chat.completion',
        model: body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: plan.text == null ? `${name}:ok` : plan.text },
          finish_reason: plan.finish || 'stop'
        }],
        usage: { prompt_tokens: 5, completion_tokens: tokens, total_tokens: 5 + tokens }
      }))
    })
  })

  server.on('connection', (socket) => {
    socket.on('close', () => { state.closedSockets += 1 })
  })

  await new Promise((resolve2) => server.listen(0, '127.0.0.1', () => resolve2()))

  return {
    name,
    port: server.address().port,
    get url() { return `http://127.0.0.1:${this.port}/v1` },
    state,
    get requests() { return state.requests },
    lastChatBody() {
      const hit = [...state.requests].reverse().find((r) => r.url.endsWith('/chat/completions'))
      return hit ? hit.body : null
    },
    chatBodies() {
      return state.requests.filter((r) => r.url.endsWith('/chat/completions')).map((r) => r.body)
    },
    close() {
      state.closed = true
      return new Promise((resolve2) => server.close(() => resolve2()))
    }
  }
}

/** 默认的"好答案" */
export const GOOD_TEXT = '混合推理把 NPU 与 GPU 放在同一棵进程树里，既省电又能兜底，宿主退出时整棵树会被内核连带清零。'
export const REFUSAL_TEXT = '抱歉，我无法完成这个请求，因为我不具备相关能力，请你换一个问题再试一次。'

/**
 * 装配一个被测 hybrid 实例。npu/gpu 传假引擎（或 null 表示该引擎不可用）。
 * 返回的实例上额外挂了 `ensureCalls`（记录 ensureEngine 的调用顺序，用于断言
 * "status() 不会拉起进程" 这类行为）。
 */
export function buildHybrid({ npu = null, gpu = null, hybrid = {}, log, fetchImpl, saveConfig, ensureHook } = {}) {
  const urls = { npu: npu && npu.url, gpu: gpu && gpu.url }
  const ensureCalls = []
  const h = createHybrid({
    config: {
      hybrid: {
        mode: 'route',
        draftModel: 'qwen3.5:0.8b',
        verifyModel: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
        embedModel: 'embed-gemma:300m',
        shortQueryTokens: 48,
        raceTimeoutMs: 400,
        requestTimeoutMs: 4000,
        firstTokenTimeoutMs: 1200,
        ...hybrid
      }
    },
    log: log || (() => {}),
    ensureEngine: async (id) => {
      ensureCalls.push(id)
      if (ensureHook) {
        const r = await ensureHook(id)
        if (r === false) throw new Error(`hook 拒绝 ${id}`)
      }
      if (!urls[id]) throw new Error(`引擎 ${id} 没起来`)
      return { id, url: urls[id] }
    },
    engineURL: (id) => {
      if (!urls[id]) throw new Error(`引擎 ${id} 没起来`)
      return urls[id]
    },
    saveConfig,
    fetchImpl
  })
  h.ensureCalls = ensureCalls
  return h
}