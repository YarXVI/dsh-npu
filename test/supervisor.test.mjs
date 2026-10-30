import { test } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NpuSupervisor } from '../lib/supervisor.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fake = path.join(here, 'fake-flm.mjs')
const node = process.execPath

function makeSupervisor(overrides = {}) {
  return new NpuSupervisor({
    exePath: node,
    koffiPath: 'D:/DeepSeek/resources/app.asar.unpacked/dsh/node_modules/koffi',
    readyTimeoutSec: 20,
    slots: [
      { id: 'chat', model: 'qwen3.5:0.8b', args: [fake, '--model', '{model}', '--port', '{port}'], idleSec: 1 },
      { id: 'mt', model: 'hy-mt2-flash:1.8b', args: [fake, '--model', '{model}', '--port', '{port}'], idleSec: 1 }
    ],
    ...overrides
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function chat(front, model) {
  const r = await fetch(`${front}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })
  })
  return { status: r.status, body: await r.json() }
}

test('按需启动、按 model 路由、空闲回收', async () => {
  const sup = makeSupervisor()
  const front = await sup.start()
  try {
    // 只起代理，不起任何模型进程
    let st = sup.status()
    assert.equal(st.slots.filter((s) => s.running).length, 0, '启动时不应有模型进程')

    // /v1/models 不拉起进程
    const models = await (await fetch(`${front}/models`)).json()
    assert.equal(models.data.length, 2)
    assert.equal(sup.status().slots.filter((s) => s.running).length, 0, '列模型不应拉起进程')

    // 第一次请求 → 拉起 chat
    const a = await chat(front, 'qwen3.5:0.8b')
    assert.equal(a.status, 200)
    assert.equal(a.body.choices[0].message.content, 'pong:qwen3.5:0.8b')
    st = sup.status()
    assert.equal(st.slots.find((s) => s.id === 'chat').running, true)
    assert.equal(st.slots.find((s) => s.id === 'mt').running, false, '未请求的模型不应启动')

    // 第二次请求复用同一个进程
    const pid = st.slots.find((s) => s.id === 'chat').pid
    await chat(front, 'qwen3.5:0.8b')
    assert.equal(sup.status().slots.find((s) => s.id === 'chat').pid, pid, '不应重启')

    // 另一个模型独立启动
    const b = await chat(front, 'hy-mt2-flash:1.8b')
    assert.equal(b.body.choices[0].message.content, 'pong:hy-mt2-flash:1.8b')
    assert.equal(sup.status().slots.find((s) => s.id === 'mt').running, true)

    // 闲置 1s 后回收
    await sleep(2600)
    st = sup.status()
    assert.equal(st.slots.filter((s) => s.running).length, 0, '空闲后应全部退出')
  } finally {
    sup.dispose()
  }
})

test('embedding 走同一个进程，路径正确代理', async () => {
  const sup = makeSupervisor()
  const front = await sup.start()
  try {
    const r = await fetch(`${front}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.5:0.8b', input: 'hello' })
    })
    const j = await r.json()
    assert.equal(j.data[0].embedding.length, 3)
  } finally {
    sup.dispose()
  }
})

test('dispose 之后不留进程', async () => {
  const sup = makeSupervisor()
  const front = await sup.start()
  await chat(front, 'qwen3.5:0.8b')
  const pid = sup.status().slots.find((s) => s.id === 'chat').pid
  assert.ok(pid)
  sup.dispose()
  await sleep(800)
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  assert.equal(alive, false, `pid ${pid} 应该已经退出`)
})
