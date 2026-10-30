/**
 * 自带 LLM adapter：把 dsh-npu 的本地代理接进 ctx.llm，不依赖 llm-pi-ai 的配置行。
 *
 * 契约来自 @deepseek-ai/dsh-llm 的 registerAdapter：
 *   listModels(provider)            → [{ provider, id, name, inputModalities }]
 *   resolveModel(provider, model)   → { provider, id, name, inputModalities, context:{contextWindow} }
 *   prepareCall(provider, model)    → { model, stream(options) }
 *   stream(options)                 → AsyncGenerator<StreamChunk>
 *
 * StreamChunk 种类：
 *   { type:'block-start', index, blockType:'text'|'reasoning' }
 *   { type:'text-delta', index, text } / { type:'reasoning-delta', index, text }
 *   { type:'block-end', index, block:{ type:'text', text } }
 *   { type:'usage', usage:{ inputTokens, outputTokens, totalTokens } }
 *   { type:'finish', reason:{ kind:'stop'|'max-tokens'|'error'|'aborted' } }
 */

/** DSH 的 Message → OpenAI messages */
function toOpenAIMessages(messages) {
  const out = []
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'
    const content = m.content
    if (typeof content === 'string') {
      out.push({ role, content })
      continue
    }
    const parts = []
    for (const block of content || []) {
      if (block && block.type === 'text' && block.text) parts.push(block.text)
      // 图片等其它块暂时丢弃：FLM 的视觉输入还没接
    }
    if (parts.length) out.push({ role, content: parts.join('\n') })
  }
  return out
}

function mapFinish(reason) {
  if (reason === 'length') return { kind: 'max-tokens' }
  if (reason === 'tool_calls') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

export function createAdapter(opts) {
  const { models, log, ensure } = opts
  // 端口可能在运行期变化（或配置与实际不一致），所以每次请求都重新取
  const endpoint = () => (typeof opts.getBaseURL === 'function' ? opts.getBaseURL() : opts.baseURL)
  const byId = new Map(models.map((m) => [m.id, m]))

  function info(provider, id) {
    const m = byId.get(id) || {}
    return {
      provider,
      id,
      name: m.name || id,
      inputModalities: ['text'],
      context: { contextWindow: m.contextWindow || 8192 }
    }
  }

  const adapter = {
    // 注册时 llm 服务先要这两个：providerInfo 必须原样带回 id，且 name 非空
    providerInfo(provider) {
      return { id: provider, name: opts.displayName || '本机 NPU' }
    },
    providerRetryPolicy() {
      return undefined   // 交给 llm 服务用默认重试策略
    },

    async listModels(provider) {
      return models.map((m) => ({
        provider,
        id: m.id,
        name: m.name || m.id,
        inputModalities: ['text']
      }))
    },

    async resolveModel(provider, model) {
      return info(provider, model)
    },

    async prepareCall(provider, model) {
      return {
        model: info(provider, model),
        stream: (options) => adapter.stream(options)
      }
    },

    async *stream(options) {
      // 代理还没起来就先等它（插件刚加载、DSH 刚启动时会发生）
      if (ensure) await ensure()
      const modelId = options.model
      const m = byId.get(modelId) || {}
      const body = {
        model: modelId,
        messages: toOpenAIMessages(options.messages),
        stream: true,
        // FLM 只有带上这个才会在流末尾发 usage
        stream_options: { include_usage: true }
      }
      if (options.temperature !== undefined) body.temperature = options.temperature
      if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
      if (m.think === false) body.think = false
      if (m.extraBody) Object.assign(body, m.extraBody)

      const res = await fetch(`${endpoint()}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal
      })
      if (!res.ok) {
        let detail = ''
        try { detail = (await res.text()).slice(0, 300) } catch { /* ignore */ }
        throw new Error(`npu-local ${res.status}: ${detail}`)
      }

      const ctype = (res.headers.get('content-type') || '').toLowerCase()
      // 后端没按 SSE 回：一次性 JSON
      if (!res.body || ctype.indexOf('application/json') === 0) {
        const data = await res.json()
        const text = data?.choices?.[0]?.message?.content || ''
        if (text) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        }
        yield { type: 'usage', usage: usageOf(data?.usage) }
        yield { type: 'finish', reason: mapFinish(data?.choices?.[0]?.finish_reason) }
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let text = ''
      let reasoning = ''
      let textStarted = false
      let reasoningStarted = false
      let usage = null
      let finish = null

      const handle = function* (line) {
        let t = line.trim()
        if (!t || t.charAt(0) === ':') return
        if (t.startsWith('data:')) t = t.slice(5).trim()
        if (!t || t === '[DONE]') return
        let obj
        try { obj = JSON.parse(t) } catch { return }
        if (obj.usage) usage = obj.usage
        const c = obj.choices && obj.choices[0]
        if (!c) return
        const d = c.delta || {}
        if (d.reasoning_content) {
          if (!reasoningStarted) { reasoningStarted = true; yield { type: 'block-start', index: 1, blockType: 'reasoning' } }
          reasoning += d.reasoning_content
          yield { type: 'reasoning-delta', index: 1, text: d.reasoning_content }
        }
        if (d.content) {
          if (!textStarted) { textStarted = true; yield { type: 'block-start', index: 0, blockType: 'text' } }
          text += d.content
          yield { type: 'text-delta', index: 0, text: d.content }
        }
        if (c.finish_reason) finish = c.finish_reason
      }

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          yield* handle(line)
          nl = buf.indexOf('\n')
        }
      }
      if (buf.trim()) yield* handle(buf)

      if (reasoningStarted) yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: reasoning } }
      if (textStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: usageOf(usage) }
      yield { type: 'finish', reason: mapFinish(finish) }
    }
  }

  return adapter
}

function usageOf(u) {
  if (!u) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  return {
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    totalTokens: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0)
  }
}
