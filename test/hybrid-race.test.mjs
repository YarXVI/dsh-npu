/**
 * 第五框架 · race 模式
 *   - 非流式：两引擎同时发，首个**完整**答案胜出，另一方被 AbortController 取消
 *   - 流式：契约要求退化为 route
 *   - 决策预算 raceTimeoutMs：慢的一方先掐掉，GPU 继续跑到总超时
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { startFakeEngine, buildHybrid, GOOD_TEXT } from './hybrid-fakes.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('race: GPU 先答完 → GPU 胜出，NPU 请求被掐断', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ hangMs: 1500, text: 'npu 的慢答案' }))
  const gpu = await startFakeEngine('gpu', () => ({ hangMs: 30, text: 'gpu 的快答案' }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'race', raceTimeoutMs: 900, requestTimeoutMs: 4000 } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: '用一句话解释进程树' }] })
  assert.equal(out.engine, 'hybrid')
  assert.equal(out.timings.mode, 'race')
  assert.equal(out.timings.winner, 'gpu')
  assert.equal(out.timings.loser, 'npu')
  assert.equal(out.text, 'gpu 的快答案')
  assert.equal(npu.state.chatCalls, 1, 'NPU 必须确实被发过请求（不是没发）')
  assert.equal(gpu.state.chatCalls, 1)

  await sleep(200)
  assert.ok(npu.state.aborted >= 1, `落败方必须被取消，实际 aborted=${npu.state.aborted}`)
})

test('race: NPU 先答完 → NPU 胜出', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ hangMs: 20, text: 'npu 的快答案' }))
  const gpu = await startFakeEngine('gpu', () => ({ hangMs: 1500, text: 'gpu 的慢答案' }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'race', raceTimeoutMs: 900 } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: '你好' }] })
  assert.equal(out.timings.winner, 'npu')
  assert.equal(out.text, 'npu 的快答案')
  await sleep(200)
  assert.ok(gpu.state.aborted >= 1, 'GPU 落败后必须被取消')
})

test('race: 决策预算用完后掐掉慢的一方，GPU 仍能给出完整答案', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ hangMs: 3000, text: '永远不会到' }))
  const gpu = await startFakeEngine('gpu', async () => { await sleep(500); return { text: 'GPU 的完整答案' } })
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'race', raceTimeoutMs: 200, requestTimeoutMs: 4000 } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const t0 = Date.now()
  const out = await h.chat({ messages: [{ role: 'user', content: '你好' }] })
  const elapsed = Date.now() - t0
  assert.equal(out.timings.winner, 'gpu')
  assert.equal(out.text, 'GPU 的完整答案')
  assert.ok(elapsed < 2500, `不该等满 requestTimeout（实际 ${elapsed}ms）`)
  const slow = out.timings.attempts.find((a) => a.engine === 'npu')
  assert.ok(slow && slow.ok === false, '慢的一方应记录为失败/取消')
  assert.equal(slow.slow, true, '应标记为 race 预算超时被掐')
})

test('race: 两边都失败 → 明确 503 并列出两次尝试', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ status: 500, message: 'npu boom' }))
  const gpu = await startFakeEngine('gpu', () => ({ status: 502, message: 'gpu boom' }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'race' } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  await assert.rejects(
    () => h.chat({ messages: [{ role: 'user', content: '你好' }] }),
    (err) => {
      assert.equal(err.status, 503)
      assert.match(err.message, /都不可用/)
      assert.equal((err.attempts || []).length, 2, '两次尝试都要留痕')
      return true
    }
  )
})

test('race: 流式请求退化为 route（契约要求）', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: 'npu 不该被叫' }))
  const gpu = await startFakeEngine('gpu', (kind, body) => ({ text: 'export function parse() {}' }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'race' } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({
    messages: [{ role: 'user', content: '写一个 parse 函数，把 SSE 流拆成事件。\n```ts\n```' }],
    mode: 'race',
    stream: true
  })
  assert.equal(out.timings.degradedFrom, 'race')
  assert.equal(out.timings.engine, 'gpu')
  assert.equal(npu.state.chatCalls, 0, '流式 race 不能并发打两个引擎')
  let text = ''
  for await (const frame of out.stream) text += frame
  assert.match(text, /parse/)
  assert.equal(gpu.state.chatCalls, 1)
})

test('race: dispose 期间在飞的请求全部被掐断', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ hangMs: 1200, text: 'npu' }))
  const gpu = await startFakeEngine('gpu', () => ({ hangMs: 1200, text: 'gpu' }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'race', raceTimeoutMs: 2000, requestTimeoutMs: 4000 } })
  t.after(async () => { await npu.close(); await gpu.close() })

  const p = h.chat({ messages: [{ role: 'user', content: GOOD_TEXT }] })
  await sleep(80)
  h.dispose()
  await assert.rejects(() => p)
  await sleep(150)
  assert.ok(npu.state.aborted + gpu.state.aborted >= 1, 'dispose 必须掐断在飞的请求')
})