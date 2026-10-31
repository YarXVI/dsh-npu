/**
 * 第五框架 · route 模式
 *   - embeddings / 翻译 → NPU；chat / 代码 / 长文 → GPU
 *   - 单引擎失败自动换另一个；两个都不行 → 明确 503（绝不静默降级到云端）
 *   - 只允许回环地址
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { startFakeEngine, buildHybrid, GOOD_TEXT } from './hybrid-fakes.mjs'

const CODE_PROMPT = '帮我写一个 TypeScript 函数，把 SSE 流按行解析成事件。\n```ts\nfunction parse(buf: string) {\n```'
const LONG_PROMPT = '请阅读下面这段材料并给出结论：' + '本地推理的进程归属必须由宿主进程树兜底。'.repeat(40)

test('route: embeddings 走 NPU，GPU 完全不被调用', async (t) => {
  const npu = await startFakeEngine('npu', (kind) => kind === 'embeddings' ? { vectors: [[0.11, 0.22, 0.33]] } : { text: GOOD_TEXT })
  const gpu = await startFakeEngine('gpu', () => ({ text: GOOD_TEXT }))
  const h = buildHybrid({ npu, gpu })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.embed({ input: '什么是 NPU' })
  assert.equal(out.engine, 'npu')
  assert.deepEqual(out.vectors, [[0.11, 0.22, 0.33]])
  assert.equal(npu.state.embedCalls, 1)
  assert.equal(gpu.state.chatCalls + gpu.state.embedCalls, 0, '嵌入不该碰 GPU')
})

test('route: 短翻译走 NPU，理由可解释', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: 'The weather is nice today.' }))
  const gpu = await startFakeEngine('gpu', () => ({ text: GOOD_TEXT }))
  const h = buildHybrid({ npu, gpu })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({
    messages: [
      { role: 'system', content: '你是翻译引擎，把用户的话翻译成英文。' },
      { role: 'user', content: '今天天气很好。' }
    ]
  })
  assert.equal(out.engine, 'npu', '翻译应由 NPU 承接')
  assert.equal(out.timings.reason, 'translation')
  assert.equal(out.text, 'The weather is nice today.')
  assert.equal(gpu.state.chatCalls, 0)
})

test('route: 代码请求走 GPU', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: 'npu 不该回这个' }))
  const gpu = await startFakeEngine('gpu', () => ({ text: 'export function parse() {}' }))
  const h = buildHybrid({ npu, gpu })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: CODE_PROMPT }] })
  assert.equal(out.engine, 'gpu')
  assert.equal(out.timings.reason, 'code')
  assert.equal(npu.state.chatCalls, 0)
})

test('route: 长文走 GPU（超过阈值）', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: GOOD_TEXT }))
  const gpu = await startFakeEngine('gpu', () => ({ text: GOOD_TEXT }))
  const h = buildHybrid({ npu, gpu })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: LONG_PROMPT }] })
  assert.equal(out.engine, 'gpu')
  assert.equal(out.timings.reason, 'long')
  assert.equal(npu.state.chatCalls, 0)
})

test('route: NPU 不可用 → 自动换 GPU，结果标 hybrid 并记 winner', async (t) => {
  const gpu = await startFakeEngine('gpu', () => ({ text: 'GPU 兜底答案' }))
  const h = buildHybrid({ npu: null, gpu })
  t.after(async () => { h.dispose(); await gpu.close() })

  const out = await h.chat({
    messages: [{ role: 'system', content: '翻译成英文' }, { role: 'user', content: '你好' }]
  })
  assert.equal(out.engine, 'hybrid', '降级后必须让调用方知道是混合链路给的答案')
  assert.equal(out.timings.winner, 'gpu')
  assert.equal(out.timings.fallback, true)
  assert.equal(out.timings.attempts[0].engine, 'npu')
  assert.equal(out.timings.attempts[0].ok, false)
  assert.equal(out.text, 'GPU 兜底答案')
})

test('route: 两个引擎都不可用 → 明确 503，不静默降级', async (t) => {
  const h = buildHybrid({ npu: null, gpu: null })
  t.after(() => h.dispose())

  await assert.rejects(
    () => h.chat({ messages: [{ role: 'user', content: '你好' }] }),
    (err) => {
      assert.equal(err.name, 'HybridError')
      assert.equal(err.status, 503)
      assert.match(err.message, /都不可用/)
      return true
    }
  )
  await assert.rejects(
    () => h.embed({ input: 'x' }),
    (err) => err.status === 503
  )
})

test('route: 拒绝非回环地址（端口不得外泄）', async (t) => {
  const { createHybrid } = await import('../lib/hybrid.mjs')
  const h = createHybrid({
    config: { hybrid: { mode: 'route' } },
    ensureEngine: async () => ({}),
    engineURL: () => 'http://192.168.1.50:8080/v1'
  })
  t.after(() => h.dispose())
  await assert.rejects(
    () => h.chat({ messages: [{ role: 'user', content: '你好' }] }),
    (err) => {
      assert.match(err.message, /回环|都不可用/)
      return true
    }
  )
})

test('status: 不拉起进程，只报已知状态与策略', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: GOOD_TEXT }))
  const gpu = await startFakeEngine('gpu', () => ({ text: GOOD_TEXT }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'cascade', shortQueryTokens: 32 } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const st = h.status()
  assert.equal(h.ensureCalls.length, 0, 'status() 不能触发引擎启动')
  assert.deepEqual(st.modes, ['auto', 'route', 'race', 'cascade', 'augment'])
  assert.equal(st.mode, 'cascade')
  assert.equal(st.policy.shortQueryTokens, 32)
  assert.deepEqual(st.engines.map((e) => e.id), ['npu', 'gpu'])
  assert.equal(st.engines[0].ready, false)

  await h.chat({ messages: [{ role: 'user', content: '你好' }] })
  assert.equal(h.status().engines[0].ready, true, '请求成功后应标记 ready')
  assert.ok(h.status().last, '应记录最近一次编排')
})

test('configure: 生效并透传给 saveConfig（不自己写文件）', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: GOOD_TEXT }))
  const gpu = await startFakeEngine('gpu', () => ({ text: GOOD_TEXT }))
  let saved = null
  const h = buildHybrid({ npu, gpu, saveConfig: async (patch) => { saved = patch } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const next = await h.configure({ mode: 'race', shortQueryTokens: 96, raceTimeoutMs: 5000 })
  assert.equal(next.mode, 'race')
  assert.equal(next.shortQueryTokens, 96)
  assert.ok(saved && saved.hybrid && saved.hybrid.mode === 'race', '必须经 saveConfig 持久化')
  assert.equal(h.status().mode, 'race')
  // 非法模式被归一化成 auto，不会让配置炸掉
  const bad = await h.configure({ mode: 'nonsense' })
  assert.ok(['auto', 'route', 'race', 'cascade', 'augment'].includes(bad.mode))
})