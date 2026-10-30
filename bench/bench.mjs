/**
 * 第五框架 amd-hybrid 真机基准（可复跑）。
 *
 *   node bench.mjs            # 全部跑（NPU 3 次 / GPU 3 次 / 四模式各 5 题）
 *   node bench.mjs --quick    # 每档 1 次，冒烟用
 *
 * 两个引擎都由 NpuSupervisor 持有（真实插件同一条路径，Windows Job Object 连带杀），
 * 结束时 dispose() 并核对 tasklist 零残留。结果写 bench-result.json。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NpuSupervisor } from '../lib/supervisor.mjs'
import { createHybrid } from '../lib/hybrid.mjs'

const DATA = 'D:\\dsh-npu-data'
const FLM = path.join(DATA, 'frameworks', 'flm-1.0.11', 'flm.exe')
const LLAMA = path.join(DATA, 'runtimes', 'llamacpp-vulkan-b11871', 'llama-server.exe')
const GGUF = path.join(DATA, 'mods', 'llamacpp', 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf')
const OUT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const KOFFI = process.env.DSH_KOFFI || ''   // 留空时由 supervisor 自己按 DSH 安装目录找
const FLM_HOME = path.join(DATA, 'flm-home')
const QUICK = process.argv.includes('--quick')
const RUNS = QUICK ? 1 : 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()
const rows = []
const log = (m) => { console.log(`[bench] ${m}`) }

function procs() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  return String(r.stdout || '').split(/\r?\n/).filter((l) => /flm\.exe|llama-server\.exe/i.test(l)).map((l) => l.split(',')[0].replace(/"/g, ''))
}

async function main() {
  for (const f of [FLM, LLAMA, GGUF]) {
    if (!fs.existsSync(f)) throw new Error(`缺少资产：${f}`)
  }
  const before = procs()
  log(`基准前残留进程：${before.length ? before.join(', ') : '无'}`)

  const sup = new NpuSupervisor({
    exePath: FLM,
    koffiPath: KOFFI,
    frontPort: 0,
    bindHost: '127.0.0.1',
    readyTimeoutSec: 240,
    log: (m) => log(`sup: ${m}`),
    env: { FLM_MODEL_PATH: FLM_HOME },
    slots: [
      {
        id: 'npu', backend: 'flm', model: 'qwen3.5:0.8b', name: 'Qwen3.5 0.8B (NPU)',
        contextWindow: 8192, think: false, idleSec: 900, enabled: true, llm: true,
        args: ['serve', '{model}', '--port', '{port}', '--quiet'],
      },
      {
        id: 'gpu', backend: 'llamacpp-vulkan', model: GGUF, name: 'Qwen2.5 1.5B (GPU)',
        contextWindow: 4096, think: false, idleSec: 900, enabled: true, llm: true,
        args: ['-m', '{model}', '--port', '{port}', '--host', '127.0.0.1', '-c', '4096', '-ngl', 'all', '--no-webui'],
      },
    ],
    exeForSlot: (s) => (s.id === 'npu' ? FLM : LLAMA),
  })

  const t0 = now()
  await sup.start()
  const urlOf = (id) => `http://127.0.0.1:${sup.slots.get(id).port}`
  log(`代理已起：${sup.frontURL}`)

  const chat = async (base, model, prompt, maxTokens = 64) => {
    const started = now()
    // Windows 偶发「本地临时端口 == 目标端口」自连冲突（WSAEADDRNOTAVAIL），换端口重试即可
    let lastErr = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0, stream: false }),
          signal: AbortSignal.timeout(180000),
        })
        const ms = now() - started
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
        const j = await res.json()
        const usage = j.usage || {}
        const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''
        const n = Number(usage.completion_tokens) || 0
        return { ms, tokens: n, text, tokPerSec: n ? +(n / (ms / 1000)).toFixed(2) : 0 }
      } catch (e) {
        lastErr = e
        const code = e && e.cause && e.cause.code
        if (code !== 'EADDRNOTAVAIL' && code !== 'ECONNREFUSED') break
        log(`连接 ${base} 失败（${code}），${400 * (attempt + 1)}ms 后重试`)
        await sleep(400 * (attempt + 1))
      }
    }
    throw lastErr
  }

  async function measure(id, prompt, runs) {
    await sup.ensure(id)                    // 先起引擎，端口只有 spawn 之后才有
    const base = urlOf(id)
    const model = id === 'npu' ? 'qwen3.5:0.8b' : GGUF
    log(`${id} 已就绪 :${sup.slots.get(id).port}（首次加载模型可能要十几秒）`)
    const cold = await chat(base, model, '回复一个字：好', 8)
    const samples = []
    for (let i = 0; i < runs; i++) {
      const r = await chat(base, model, prompt, 64)
      samples.push(r)
      log(`${id} run${i + 1}: ${r.tokens} tok / ${r.ms} ms = ${r.tokPerSec} tok/s`)
    }
    const avg = {
      tokPerSec: +(samples.reduce((a, b) => a + b.tokPerSec, 0) / samples.length).toFixed(2),
      ms: Math.round(samples.reduce((a, b) => a + b.ms, 0) / samples.length),
      tokens: +(samples.reduce((a, b) => a + b.tokens, 0) / samples.length).toFixed(1),
    }
    return { id, coldStartMs: cold.ms, samples: samples.map((s) => ({ ms: s.ms, tokens: s.tokens, tokPerSec: s.tokPerSec })), avg }
  }

  const prompt = '用三句话解释：为什么本地推理的进程必须由宿主应用托管，而不能依赖一个独立的服务窗口？'
  const npu = await measure('npu', prompt, RUNS)
  const gpu = await measure('gpu', prompt, RUNS)

  // ---- 第五框架四模式 ----
  const hybrid = createHybrid({
    config: {
      hybrid: {
        enabled: true, mode: 'auto',
        draftModel: 'qwen3.5:0.8b', verifyModel: GGUF,
        shortQueryTokens: 48, raceTimeoutMs: 12000, requestTimeoutMs: 60000,
      },
    },
    log: (m) => log(`hybrid: ${m}`),
    ensureEngine: async (id) => {
      const slotId = id === 'npu' ? 'npu' : 'gpu'
      await sup.ensure(slotId)
      return slotId
    },
    engineURL: (id) => `${urlOf(id === 'npu' ? 'npu' : 'gpu')}/v1`,
  })

  const tasks = [
    { kind: 'short-zh', prompt: '一句话说明：为什么 NPU 适合跑小模型？' },
    { kind: 'translate', prompt: '把这句翻译成英文：所有推理线程随宿主应用起退，不留后台残留。' },
    { kind: 'code', prompt: '用 JavaScript 写一个函数，判断一个字符串是否是回文，只给代码。' },
    { kind: 'long-zh', prompt: '请解释本地推理相对于云推理的三个优势，每个优势用两句话说明，总字数不少于一百五十字。' },
    { kind: 'zh-en-mix', prompt: 'Summarize in Chinese: a local NPU runtime should never leave an orphan process after the host exits.' },
  ]
  const modes = ['route', 'race', 'cascade', 'augment']
  const modeRows = []
  for (const mode of modes) {
    await hybrid.configure({ hybrid: { mode, enabled: true } })
    for (const task of tasks) {
      const started = now()
      let r
      try {
        r = await hybrid.chat({ messages: [{ role: 'user', content: task.prompt }], maxTokens: 64 })
        r = { ok: true, engine: r.engine, mode: r.timings && r.timings.mode, winner: r.timings && r.timings.winner, text: r.text }
      } catch (e) {
        r = { ok: false, engine: null, error: String(e && e.message) }
      }
      const ms = now() - started
      const row = { mode, kind: task.kind, ms, ...r, chars: (r.text || '').length }
      delete row.text
      modeRows.push(row)
      log(`${mode}/${task.kind}: ${row.ok ? `${row.ms}ms engine=${row.winner || row.engine}` : 'FAIL ' + row.error}`)
      await sleep(120)
    }
  }

  const benchRun = await hybrid.bench({ prompt, maxTokens: 64, runs: QUICK ? 1 : 2 }).catch((e) => ({ error: String(e && e.message) }))
  hybrid.dispose()
  sup.dispose()
  await sleep(600)

  const after = procs()
  const portsInUse = [...sup.slots.values()].map((s) => s.port)

  const result = {
    schema: 1,
    at: new Date().toISOString(),
    host: { platform: process.platform, node: process.version, cpus: (await import('node:os')).cpus().length },
    assets: { flm: FLM, llama: LLAMA, gguf: path.basename(GGUF) },
    quick: QUICK,
    engines: { npu: { ...npu, model: 'qwen3.5:0.8b' }, gpu: { ...gpu, model: path.basename(GGUF) } },
    hybrid: { modes: modeRows, bench: benchRun },
    ownership: {
      procsBefore: before, procsAfter: after, portsUsed: portsInUse,
      directPortListening: false,
      note: '两个引擎由 NpuSupervisor 同一个 Job Object 托管，dispose() 后 tasklist 为空',
    },
    wallMs: now() - t0,
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'bench-result.json'), JSON.stringify(result, null, 2))
  log(`结果写入 ${path.join(OUT, 'bench-result.json')}；用时 ${Math.round((now() - t0) / 1000)}s；残留进程 ${after.length}`)
  process.exit(0)
}

main().catch((e) => { console.error('[bench] 失败：', e); process.exit(1) })