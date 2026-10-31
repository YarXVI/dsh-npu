/** 假 FLM：只为验证 supervisor 的按需启停/路由/回收，不需要真 NPU */
import http from 'node:http'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const model = arg('--model', 'fake')
const port = Number(arg('--port', 0))
// 模拟冷启动：延迟这么久才开始监听
const delay = Number(arg('--delay', 0))

const srv = http.createServer((req, res) => {
  const json = (obj) => {
    const b = JSON.stringify(obj)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) })
    res.end(b)
  }
  if (req.url.startsWith('/v1/models')) return json({ object: 'list', data: [{ id: model, object: 'model' }] })
  if (req.url.startsWith('/v1/embeddings')) {
    let b = ''
    req.on('data', (c) => { b += c })
    return req.on('end', () => json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }] }))
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    let b = ''
    req.on('data', (c) => { b += c })
    return req.on('end', () => {
      let body = {}
      try { body = JSON.parse(b || '{}') } catch { /* ignore */ }
      json({
        id: 'fake', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: `pong:${model}`, model: body.model }, finish_reason: 'stop' }]
      })
    })
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

setTimeout(() => srv.listen(port, '127.0.0.1', () => {
  if (process.send) process.send({ ready: true, port: srv.address().port })
}), delay)
