/**
 * 回归：数据根自动发现 / 配置合并持久化 / 槽位热更新 / FLM 模型兜底清单。
 * 全部在 os.tmpdir() 的沙箱目录里跑，不碰真实 ~/.dsh 与真实模型目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const modUrl = pathToFileURL(path.join(HERE, '..', 'index.js')).href

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npu-test-'))
  const dataRoot = path.join(dir, 'data')
  const flmDir = path.join(dataRoot, 'mods', 'flm')
  const modelDir = path.join(flmDir, 'Qwen3.5-0.8B-NPU2')
  fs.mkdirSync(modelDir, { recursive: true })
  fs.writeFileSync(path.join(modelDir, 'config.json'), '{}')
  fs.writeFileSync(path.join(modelDir, 'model.q4nx'), 'x')
  fs.mkdirSync(path.join(dataRoot, 'mods', 'llamacpp'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'mods', 'llamacpp', 'tiny.gguf'), 'x')
  // 假的 flm.exe + 它的 model_list.json（只用于「已安装模型」映射）
  const bin = path.join(dir, 'flmbin')
  fs.mkdirSync(bin, { recursive: true })
  const exe = path.join(bin, 'flm.exe')
  fs.writeFileSync(exe, '')
  fs.writeFileSync(path.join(bin, 'model_list.json'), JSON.stringify({
    model_path: 'models',
    models: { 'qwen3.5': { '0.8b': { name: 'Qwen3.5-0.8B-NPU2', default_context_length: 32768, details: { family: 'qwen3.5', parameter_size: '0.8B' } } } }
  }))
  return { dir, dataRoot, exe, configFile: path.join(dir, 'dsh-npu.json') }
}

async function boot(configFile, extra) {
  const mod = await import(modUrl + '?t=' + Date.now())
  const effects = []
  const adapters = []
  let route = null
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { const d = fn(); effects.push(d); return d },
    inject(names, cb) {
      if (!names.includes('webServer')) return
      cb({ get: () => ({ register: (r) => { route = r; return () => { route = null } } }), effect: (f) => { f(); return () => {} } })
    },
    llm: { registerAdapter(providers, adapter) { adapters.push(adapter); return () => {} } },
    tools: { register: () => () => {} }
  }
  mod.apply(ctx, { configFile, frontPort: 0, logFile: '', ...extra })
  await sleep(800)
  const call = (method, url, body) => new Promise((resolve) => {
    let code = 0, out = ''
    const req = {
      method, url, headers: {},
      on(ev, cb) { if (ev === 'data' && body) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb() }
    }
    route.handler(req, { writeHead(c) { code = c }, setHeader() {}, end(s) { out += s || ''; resolve({ code, json: (() => { try { return JSON.parse(out) } catch { return out } })() }) } })
  })
  return {
    call, effects, adapters, mod,
    dispose() { for (const d of effects.reverse()) { try { if (typeof d === 'function') d() } catch { /* ignore */ } } }
  }
}

test('数据根自动发现：显式配置优先，历史位置可被采纳', async () => {
  const sb = makeSandbox()
  const { resolveDataRoot } = await import(modUrl + '?t=' + Date.now())
  assert.equal(resolveDataRoot(sb.configFile, sb.dataRoot), sb.dataRoot)
  // 未配置时：如果配置目录旁边有 dsh-npu-data，应采纳它
  const legacy = path.join(path.dirname(sb.configFile), 'dsh-npu-data')
  fs.mkdirSync(path.join(legacy, 'mods'), { recursive: true })
  assert.equal(resolveDataRoot(sb.configFile, ''), legacy)
  fs.rmSync(sb.dir, { recursive: true, force: true })
})

test('启动：dataRoot 写入配置、FLM 模型兜底清单可见、槽位保留', async () => {
  const sb = makeSandbox()
  const slots = [
    { id: 'chat', model: 'qwen3.5:0.8b', name: 'Qwen3.5 0.8B (NPU)', contextWindow: 8192, embed: true, alsoServes: ['embed-gemma:300m'], idleSec: 180, args: ['serve', '{model}', '--port', '{port}', '--quiet'] },
  ]
  const b = await boot(sb.configFile, { dataRoot: sb.dataRoot, exePath: sb.exe, flmExe: sb.exe, slots })
  try {
    const st = await b.call('GET', '/plugins/dsh-npu/panel')
    assert.equal(st.code, 200)
    assert.equal(st.json.config.dataRoot, sb.dataRoot)
    assert.equal(st.json.config.flmFound, true)
    assert.ok(st.json.models.some((m) => m.id === 'qwen3.5:0.8b'), 'FLM 模型清单应能从 model_list.json + 目录兜底得到')
    // 配置文件应记住 dataRoot / flmExe / slots
    const disk = JSON.parse(fs.readFileSync(sb.configFile, 'utf8'))
    assert.equal(disk.dataRoot, sb.dataRoot)
    assert.equal((disk.slots || []).length, 1)
    assert.equal((st.json.startupArgs.entries || []).length, 2)
    assert.ok(st.json.updates && typeof st.json.updates === 'object')
  } finally {
    b.dispose(); fs.rmSync(sb.dir, { recursive: true, force: true })
  }
})

test('部分保存不丢字段：只改 displayName 时 slots/dataRoot/flmExe 必须保留', async () => {
  const sb = makeSandbox()
  const slots = [
    { id: 'chat', model: 'qwen3.5:0.8b', name: 'Qwen3.5 0.8B (NPU)', contextWindow: 8192, idleSec: 180, args: ['serve', '{model}', '--port', '{port}', '--quiet'] },
    { id: 'mt', model: 'hy-mt2-flash:1.8b', name: 'Hy-MT2 1.8B (NPU)', contextWindow: 1024, idleSec: 60, args: ['serve', '{model}', '--port', '{port}', '--quiet'] }
  ]
  const b = await boot(sb.configFile, { dataRoot: sb.dataRoot, exePath: sb.exe, flmExe: sb.exe, slots })
  try {
    const save = await b.call('POST', '/plugins/dsh-npu/panel/config', { displayName: '我的 NPU' })
    assert.equal(save.code, 200)
    const disk = JSON.parse(fs.readFileSync(sb.configFile, 'utf8'))
    assert.equal(disk.displayName, '我的 NPU')
    assert.equal(disk.dataRoot, sb.dataRoot)
    assert.equal(disk.flmExe, sb.exe)
    assert.equal(disk.slots.length, 2)
  } finally {
    b.dispose(); fs.rmSync(sb.dir, { recursive: true, force: true })
  }
})

test('槽位热更新：停用后 provider 与 /v1/models 同步减少，不用重启', async () => {
  const sb = makeSandbox()
  const slots = [
    { id: 'chat', model: 'qwen3.5:0.8b', name: 'Qwen3.5 0.8B (NPU)', contextWindow: 8192, idleSec: 180, args: ['serve', '{model}', '--port', '{port}', '--quiet'] },
    { id: 'mt', model: 'hy-mt2-flash:1.8b', name: 'Hy-MT2 1.8B (NPU)', contextWindow: 1024, idleSec: 60, args: ['serve', '{model}', '--port', '{port}', '--quiet'] }
  ]
  const b = await boot(sb.configFile, { dataRoot: sb.dataRoot, exePath: sb.exe, flmExe: sb.exe, slots })
  try {
    const st0 = await b.call('GET', '/plugins/dsh-npu/panel')
    const port = st0.json.runningPort
    const save = await b.call('POST', '/plugins/dsh-npu/panel/config', {
      slots: slots.map((s, i) => ({ ...s, enabled: i === 1 }))
    })
    assert.equal(save.code, 200)
    assert.deepEqual(save.json.config.providerModels.map((m) => m.id), ['hy-mt2-flash:1.8b'])
    const list = await b.adapters[b.adapters.length - 1].listModels('npu-local')
    assert.deepEqual(list.map((m) => m.id), ['hy-mt2-flash:1.8b'])
    const v1 = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()
    assert.deepEqual(v1.data.map((d) => d.id), ['hy-mt2-flash:1.8b'])
  } finally {
    b.dispose(); fs.rmSync(sb.dir, { recursive: true, force: true })
  }
})

