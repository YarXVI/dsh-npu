/**
 * 第五框架 · cascade 模式
 *   - 估算 prompt ≤ shortQueryTokens → 先 NPU
 *   - 答案被截断（finish_reason=length）/ 拒答 / 空 / 复读 → 升级 GPU 重答
 *   - 流式：首段"偷看"合格就提交；已吐出正文之后不再升级（契约要求）
 *   - 长 prompt 直接走 GPU，不浪费一次 NPU 往返
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { startFakeEngine, buildHybrid, GOOD_TEXT, REFUSAL_TEXT } from './hybrid-fakes.mjs'

const SHORT = '为什么进程树要挂在宿主下面？'
const LONG = '请分析下面这份设计说明并给出风险清单：' + '本地推理进程必须可被宿主连带清理。'.repeat(40)

test('cascade: 短问题由 NPU 答好 → 不碰 GPU', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: GOOD_TEXT, finish: 'stop' }))
  const gpu = await startFakeEngine('gpu', () => ({ text: 'gpu 不该被叫' }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'cascade' } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: SHORT }] })
  assert.equal(out.engine, 'npu')
  assert.equal(out.timings.reason, 'short-prompt')
  assert.equal(out.escalated, undefined)
  assert.equal(gpu.state.chatCalls, 0)
  assert.equal(npu.state.chatCalls, 1)
})

test('cascade: NPU 答案被截断 → 升级 GPU 重答，标 hybrid/escalated', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: '先说一半，后面', finish: 'length' }))
  const gpu = await startFakeEngine('gpu', () => ({ text: 'GPU 给出的完整答案', finish: 'stop' }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'cascade' } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: SHORT }] })
  assert.equal(out.engine, 'hybrid')
  assert.equal(out.escalated, true)
  assert.equal(out.timings.winner, 'gpu')
  assert.equal(out.timings.reason, 'escalate')
  assert.equal(out.text, 'GPU 给出的完整答案')
  const npuAttempt = out.timings.attempts.find((a) => a.engine === 'npu')
  assert.equal(npuAttempt.rejected, 'truncated', '必须记录升级原因：截断')
  assert.equal(npu.state.chatCalls, 1)
  assert.equal(gpu.state.chatCalls, 1)
})

test('cascade: NPU 拒答 → 升级 GPU', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: REFUSAL_TEXT, finish: 'stop' }))
  const gpu = await startFakeEngine('gpu', () => ({ text: '可以这样处理……', finish: 'stop' }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'cascade' } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: SHORT }] })
  assert.equal(out.engine, 'hybrid')
  assert.equal(out.timings.attempts.find((a) => a.engine === 'npu').rejected, 'refusal')
})

test('cascade: NPU 复读/空答案也算低质 → 升级', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: '的要'.repeat(30) }))
  const gpu = await startFakeEngine('gpu', () => ({ text: 'GPU 正常回答' }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'cascade' } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: SHORT }] })
  assert.equal(out.engine, 'hybrid')
  const rejected = out.timings.attempts.find((a) => a.engine === 'npu').rejected
  assert.ok(['degenerate', 'refusal'].includes(rejected), `复读应被判低质，实际 ${rejected}`)
})

test('cascade: 长 prompt 直接走 GPU，省掉 NPU 往返', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: GOOD_TEXT }))
  const gpu = await startFakeEngine('gpu', () => ({ text: 'GPU 长文答案' }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'cascade', shortQueryTokens: 48 } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: LONG }] })
  assert.equal(out.engine, 'gpu')
  assert.equal(out.timings.reason, 'long-prompt')
  assert.equal(npu.state.chatCalls, 0)
})

test('cascade: NPU 起不来 → 直接升级 GPU，reason=npu-down', async (t) => {
  const gpu = await startFakeEngine('gpu', () => ({ text: 'GPU 兜底' }))
  const h = buildHybrid({ npu: null, gpu, hybrid: { mode: 'cascade' } })
  t.after(async () => { h.dispose(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: SHORT }] })
  assert.equal(out.engine, 'hybrid')
  assert.equal(out.escalated, true)
  assert.equal(out.timings.reason, 'npu-down')
  assert.equal(out.timings.attempts[0].ok, false)
})

test('cascade(stream): 短问题 NPU 首段合格 → 提交，之后即使截断也不升级', async (t) => {
  const npu = await startFakeEngine('npu', () => ({
    text: '进程树挂在宿主下，宿主退出时整棵树被内核清零。',
    finish: 'length',
    chunkSize: 12,
    chunkDelayMs: 5
  }))
  const gpu = await startFakeEngine('gpu', () => ({ text: 'gpu 不该被叫' }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'cascade', peekChars: 12 } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: SHORT }], stream: true })
  assert.equal(out.engine, 'npu', '首段合格就提交给 NPU')
  assert.equal(out.timings.reason, 'short-prompt')
  let text = ''
  for await (const frame of out.stream) text += frame
  assert.match(text, /进程树/)
  assert.equal(gpu.state.chatCalls, 0, '已流出正文就不再升级')
})

test('cascade(stream): NPU 首段拒答（还没吐字）→ 换 GPU 流', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: REFUSAL_TEXT, chunkSize: 6, chunkDelayMs: 2 }))
  const gpu = await startFakeEngine('gpu', () => ({ text: 'GPU 来回答这个问题。', chunkSize: 6, chunkDelayMs: 2 }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'cascade', peekChars: 12 } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: SHORT }], stream: true })
  assert.equal(out.engine, 'hybrid')
  assert.equal(out.escalated, true)
  assert.equal(out.timings.engine, 'gpu')
  let text = ''
  for await (const frame of out.stream) text += frame
  // 流式帧是 SSE 分片：先按行解析并拼回正文，再断言（分片边界不可预测，不能对原始串匹配）
  const agg = text.split('\n')
    .map((l) => l.replace(/^data:\s*/, '').trim())
    .filter((l) => l && l !== '[DONE]')
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .map((o) => (o && o.choices && o.choices[0] && o.choices[0].delta && o.choices[0].delta.content) || '')
    .join('')
  assert.match(agg, /GPU 来回答/)
  assert.equal(out.timings.tokens > 0, true, '流结束后应能算出 token 数')
})

test('cascade(stream): 长 prompt 直接 GPU 流', async (t) => {
  const npu = await startFakeEngine('npu', () => ({ text: GOOD_TEXT }))
  const gpu = await startFakeEngine('gpu', () => ({ text: 'GPU 流式长文', chunkSize: 6 }))
  const h = buildHybrid({ npu, gpu, hybrid: { mode: 'cascade' } })
  t.after(async () => { h.dispose(); await npu.close(); await gpu.close() })

  const out = await h.chat({ messages: [{ role: 'user', content: LONG }], stream: true })
  assert.equal(out.engine, 'gpu')
  for await (const _ of out.stream) { /* 消费 */ }
  assert.equal(npu.state.chatCalls, 0)
})