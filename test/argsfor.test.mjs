/** supervisor 的 argsFor 钩子：启动参数文件在 spawn 时生效，并替换 {ctx}/{port} 占位符 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NpuSupervisor } from '../lib/supervisor.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fake = path.join(here, 'fake-flm.mjs')

test('argsFor 返回的参数被用于 spawn（含 {ctx}/{port} 替换）', async () => {
  const sup = new NpuSupervisor({
    exePath: process.execPath,
    frontPort: 0,
    readyTimeoutSec: 20,
    argsFor: () => [fake, '--model', '{model}', '--port', '{port}', '--ctx-len', '{ctx}'],
    slots: [{ id: 'chat', model: 'qwen3.5:0.8b', contextWindow: 4096, idleSec: 0, args: ['serve', '{model}'] }],
  })
  const front = await sup.start()
  try {
    const r = await fetch(`${front}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.5:0.8b', messages: [] }),
    })
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.equal(j.choices[0].message.content, 'pong:qwen3.5:0.8b')
  } finally { sup.dispose() }
})
