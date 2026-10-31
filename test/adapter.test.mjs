import { test } from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import { createAdapter } from '../lib/adapter.mjs'

/** 起一个假的后端，按给定脚本回 SSE */
function backend(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => handler(req, res, body ? JSON.parse(body) : {}))
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}/v1` }))
  })
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

async function collect(adapter, options) {
  const out = []
  for await (const chunk of adapter.stream(options)) out.push(chunk)
  return out
}

const MODELS = [{ id: 'qwen3.5:0.8b', name: 'Qwen', contextWindow: 8192 }]

test('纯文本流：block-start → text-delta → block-end → usage → finish', async () => {
  const { srv, base } = await backend((req, res) => sse(res, [
    { choices: [{ delta: { content: '你' }, finish_reason: null }] },
    { choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
  ]))
  try {
    const a = createAdapter({ baseURL: base, models: MODELS })
    const chunks = await collect(a, { provider: 'npu-local', model: 'qwen3.5:0.8b', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

    assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
    assert.deepEqual(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text), ['你', '好'])
    assert.deepEqual(chunks.find((c) => c.type === 'block-end'), { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } })
    assert.deepEqual(chunks.find((c) => c.type === 'usage').usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 })
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  } finally { srv.close() }
})

test('思维链走 reasoning 块，正文走 text 块', async () => {
  const { srv, base } = await backend((req, res) => sse(res, [
    { choices: [{ delta: { reasoning_content: '想一想' }, finish_reason: null }] },
    { choices: [{ delta: { content: '答' }, finish_reason: 'stop' }] }
  ]))
  try {
    const a = createAdapter({ baseURL: base, models: MODELS })
    const chunks = await collect(a, { provider: 'npu-local', model: 'qwen3.5:0.8b', messages: [] })
    const starts = chunks.filter((c) => c.type === 'block-start')
    assert.deepEqual(starts.map((s) => s.blockType).sort(), ['reasoning', 'text'])
    assert.ok(chunks.some((c) => c.type === 'reasoning-delta' && c.text === '想一想'))
  } finally { srv.close() }
})

test('finish_reason=length 映射成 max-tokens', async () => {
  const { srv, base } = await backend((req, res) => sse(res, [
    { choices: [{ delta: { content: 'a' }, finish_reason: 'length' }] }
  ]))
  try {
    const a = createAdapter({ baseURL: base, models: MODELS })
    const chunks = await collect(a, { provider: 'npu-local', model: 'qwen3.5:0.8b', messages: [] })
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  } finally { srv.close() }
})

test('后端回 JSON（不流式）也能出块', async () => {
  const { srv, base } = await backend((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '整段' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }))
  })
  try {
    const a = createAdapter({ baseURL: base, models: MODELS })
    const chunks = await collect(a, { provider: 'npu-local', model: 'qwen3.5:0.8b', messages: [] })
    assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === '整段'))
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  } finally { srv.close() }
})

test('HTTP 错误会抛出带状态码的错误', async () => {
  const { srv, base } = await backend((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"模型没起来"}}')
  })
  try {
    const a = createAdapter({ baseURL: base, models: MODELS })
    await assert.rejects(() => collect(a, { provider: 'npu-local', model: 'qwen3.5:0.8b', messages: [] }), /503/)
  } finally { srv.close() }
})

test('listModels / resolveModel 用配置里的元数据', async () => {
  const a = createAdapter({ baseURL: 'http://127.0.0.1:1/v1', models: [{ id: 'hy-mt2-flash:1.8b', name: 'Hy-MT2', contextWindow: 1024 }] })
  assert.deepEqual(await a.listModels('npu-local'), [
    { provider: 'npu-local', id: 'hy-mt2-flash:1.8b', name: 'Hy-MT2', inputModalities: ['text'] }
  ])
  const info = await a.resolveModel('npu-local', 'hy-mt2-flash:1.8b')
  assert.equal(info.context.contextWindow, 1024)
})
