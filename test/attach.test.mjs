import { test } from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import { NpuSupervisor } from '../lib/supervisor.mjs'

/**
 * P0 可行性验证：不是 FLM 的服务，插件能不能直接接管？
 * 起一个最小的 OpenAI 兼容服务（模拟 Ollama / LM Studio / llama.cpp / OVMS），
 * exePath 故意给一个不存在的路径——只要走了 spawn 就一定失败。
 */
function startForeignServer() {
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(200, { object: 'list', data: [{ id: 'llama3.2:3b', object: 'model' }] })
    }
    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/v1/embeddings')) {
      req.resume()
      req.on('end', () => {
        if (req.url.endsWith('embeddings')) {
          return send(200, { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] })
        }
        send(200, {
          choices: [{ message: { role: 'assistant', content: '接管成功' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        })
      })
      return
    }
    return send(404, { error: { message: 'not found' } })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('接管外部 OpenAI 兼容服务：不 spawn、不 kill', async (t) => {
  const foreign = await startForeignServer()
  const sup = new NpuSupervisor({
    exePath: 'this-exe-does-not-exist-and-must-never-run',
    frontPort: 0,
    readyTimeoutSec: 3,
    slots: [{ id: 'foreign', model: 'llama3.2:3b', reusePort: foreign.port, alsoServes: ['embed-x'], idleSec: 0 }]
  })

  t.after(async () => {
    try { sup.dispose() } catch { /* ignore */ }
    await new Promise((r) => foreign.server.close(r))
  })

  const front = await sup.start()

  const chat = await fetch(`${front}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'llama3.2:3b', messages: [{ role: 'user', content: 'hi' }] })
  })
  const chatText = await chat.text()
  assert.equal(chat.status, 200, '聊天应被转发，实际：' + chatText.slice(0, 200))
  assert.equal(JSON.parse(chatText).choices[0].message.content, '接管成功')

  const emb = await fetch(`${front}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embed-x', input: 'hello' })
  })
  assert.equal(emb.status, 200, 'alsoServes 里的模型也要能路由到同一个进程')

  const st = await (await fetch(front.replace(/\/v1$/, '') + '/npu/status')).json()
  assert.equal(st.slots[0].external, true, '应标记为接管')
  assert.equal(st.slots[0].starts, 0, '不该尝试 spawn，实际 starts=' + st.slots[0].starts)

  // 接管来的进程不该被我们杀掉
  sup.dispose()
  const still = await fetch(`http://127.0.0.1:${foreign.port}/v1/models`).catch(() => null)
  assert.ok(still && still.ok, 'dispose 之后外部进程必须还活着')
})
