/**
 * 后端挑选：按 policy 给出的链子逐个「装 → 查设备 → 起服务」，第一个真正可用的胜出。
 *
 * 为什么要先查设备：
 *   实测 ROCm 构建在没有 ROCm 设备的机器上 `--list-devices` 回 `(none)`，
 *   但 llama-server 仍然能启动并正常回答 —— 它悄悄降级到 CPU 了。
 *   只看 /health 会误判成「ROCm 可用」，于是白等 250MB 下载、还拿不到 GPU 加速。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ensureRuntime, installed, RUNTIMES } from './runtimes.mjs'

/**
 * 问二进制它能用哪些设备。
 * @returns {Promise<{devices: string[], raw: string}>}
 */
export function probeDevices(exe, opts = {}) {
  return new Promise((resolve) => {
    const ms = opts.timeoutMs || 20000
    let out = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      const devices = []
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z]+\d+):\s*(.+)$/.exec(line)
        if (m) devices.push(`${m[1]} ${m[2].trim()}`)
      }
      resolve({ devices, raw: out })
    }
    let child
    try {
      child = spawn(exe, ['--list-devices'], { cwd: path.dirname(exe), windowsHide: true })
    } catch {
      return resolve({ devices: [], raw: 'spawn failed' })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish()
    }, ms)
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('error', () => { clearTimeout(timer); finish() })
    child.on('exit', () => { clearTimeout(timer); finish() })
  })
}

const GPU_REQUIRED = new Set(['llamacpp-cuda', 'llamacpp-rocm', 'llamacpp-vulkan'])

/**
 * @param {Array<{id:string,label:string,reason:string}>} plan  policy.planBackends() 的结果
 * @param {{root:string, baseUrl?:string, log?:Function, onProgress?:Function, probe?:Function}} opts
 * @returns {Promise<{chosen: object|null, exe: string|null, skipped: Array, devices: string[]}>}
 */
export async function pickBackend(plan, opts = {}) {
  const probe = opts.probe || ((exe) => probeDevices(exe, opts))
  const install = opts.install || ((id, o) => ensureRuntime(id, o))
  const log = opts.log || (() => {})
  const skipped = []

  // 用户手动指定的后端优先：只试它，失败就把原因说清楚，不偷偷换成别的
  const pref = opts.pref && opts.pref !== 'auto' ? opts.pref : ''
  let candidates = plan || []
  if (pref) {
    const hit = candidates.filter((p) => p.id === pref)
    candidates = hit.length ? hit : [{
      id: pref,
      label: pref,
      reason: '你手动指定的后端',
    }]
  }

  for (const item of candidates) {
    const rt = RUNTIMES[item.id]

    // FLM：用户自己装的，检查 exe 在不在就够（模型清单由它自己管）
    if (item.id === 'flm') {
      const exe = opts.flmExe
      if (!exe || !fs.existsSync(exe)) {
        skipped.push({ id: item.id, reason: '没找到 flm.exe（在面板里填对路径）', needsExternal: true })
        continue
      }
      log(`FLM 可用：${exe}`)
      return { chosen: item, exe, skipped, devices: [] }
    }

    if (!rt) {
      skipped.push({ id: item.id, reason: '不是内置运行时（需要本机已安装）', needsExternal: true })
      continue
    }

    // 外挂运行时（如 CUDA）：插件不下、不占体积，用户自己放进 extras/
    if (rt.external) {
      const found = installed(opts.root, item.id)
      if (!found) {
        skipped.push({ id: item.id, reason: rt.hint || '需要自己安装', needsExternal: true })
        continue
      }
      log(`${item.label}：使用用户自备的 ${found}`)
      const { devices } = GPU_REQUIRED.has(item.id) ? await probe(found) : { devices: [] }
      if (GPU_REQUIRED.has(item.id) && !devices.length) {
        skipped.push({ id: item.id, reason: '自备的构建没有可用设备' })
        continue
      }
      return { chosen: item, exe: found, skipped, devices }
    }

    let exe
    try {
      const r = await install(item.id, {
        root: opts.root,
        baseUrl: opts.baseUrl,
        onProgress: opts.onProgress,
        log,
      })
      exe = r.exe
    } catch (e) {
      skipped.push({ id: item.id, reason: '装不上：' + (e && e.message) })
      continue
    }

    // CPU 后端不需要显卡，直接通过
    if (GPU_REQUIRED.has(item.id)) {
      const { devices } = await probe(exe)
      if (!devices.length) {
        skipped.push({ id: item.id, reason: '这个构建在你这台机器上没有可用设备（会悄悄退回 CPU）' })
        continue
      }
      log(`${item.label} 可用设备：${devices.join(' / ')}`)
      return { chosen: item, exe, skipped, devices }
    }

    return { chosen: item, exe, skipped, devices: [] }
  }

  return { chosen: null, exe: null, skipped, devices: [] }
}

/** 这个运行时是否已经装好（不触发下载） */
export function isInstalled(root, id) {
  return !!installed(root, id)
}
