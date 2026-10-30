/** 模拟 DSH 崩溃：拉起一个模型进程后直接硬退出，不执行 dispose */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NpuSupervisor } from '../lib/supervisor.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fake = path.join(here, 'fake-flm.mjs')

const sup = new NpuSupervisor({
  exePath: process.execPath,
  koffiPath: 'D:/DeepSeek/resources/app.asar.unpacked/dsh/node_modules/koffi',
  readyTimeoutSec: 20,
  slots: [{ id: 'chat', model: 'qwen3.5:0.8b', args: [fake, '--model', '{model}', '--port', '{port}'], idleSec: 600 }]
})

const front = await sup.start()
await fetch(`${front}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'qwen3.5:0.8b', messages: [{ role: 'user', content: 'hi' }] })
}).then((r) => r.text())

const slot = sup.status().slots[0]
process.stdout.write(JSON.stringify({ pid: slot.pid, job: sup.status().jobObject }) + '\n')
process.exit(9)   // 硬退出，故意不 dispose
