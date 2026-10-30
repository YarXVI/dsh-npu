/**
 * 框架更新：启动时检查镜像仓库（GitHub Release，可选镜像前缀）里 FLM / llama.cpp 是否有新版本，
 * 面板上给出「更新框架」按钮；更新包下载到插件自己的数据根，不覆盖用户手动安装的那份。
 *
 * 设计约束：
 *   - 只认官方 Release（FLM: ROCm/FastFlowLM，llama.cpp: ggml-org/llama.cpp）；
 *   - 下载必须校验 sha256（GitHub API 现在会返回 asset.digest）；
 *   - 解压用系统自带 tar（Windows 10+ 的 bsdtar 支持 zip）；
 *   - 安装到 <dataRoot>/frameworks/flm-<ver> 或 <dataRoot>/runtimes/llamacpp-<variant>-<build>；
 *   - 网络失败/没资产都只报「无法检查」，绝不影响插件主流程。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn as childSpawn } from 'node:child_process'
import { LLAMACPP_BUILD } from './runtimes.mjs'

const UA = 'dsh-npu/0.12 (+https://github.com/)'
const API = 'https://api.github.com'
const FLM_REPO = 'ROCm/FastFlowLM'
const LLAMA_REPO = 'ggml-org/llama.cpp'
const FLM_PAGE = 'https://github.com/ROCm/FastFlowLM/releases'
const LLAMA_PAGE = 'https://github.com/ggml-org/llama.cpp/releases'

const VARIANTS = {
  'llamacpp-vulkan': 'vulkan',
  'llamacpp-rocm': 'rocm-10.0',
  'llamacpp-cuda': 'cuda-12.4',
}

async function getJson(url, timeoutMs = 15000) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

/** 可选的下载镜像前缀：把 https://github.com/... 改写成 <mirror>https://github.com/... */
export function withMirror(url, mirror) {
  const m = String(mirror || '').trim()
  if (!m || !/^https?:\/\//i.test(m)) return url
  return m.replace(/\/+$/, '') + '/' + url
}

/** 版本比较：1.0.11 > 1.0.10；非数字段按字符串比 */
export function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const pb = String(b || '').replace(/^v/i, '').split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i]
    if (x === undefined) return typeof y === 'string' ? 1 : 0
    if (y === undefined) return typeof x === 'string' ? -1 : 0
    if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x > y ? 1 : -1; continue }
    const s = String(x).localeCompare(String(y))
    if (s !== 0) return s > 0 ? 1 : -1
  }
  return 0
}

/** llama.cpp 构建号：b11981 > b11871 */
export function compareBuild(a, b) {
  const na = Number(String(a || '').replace(/^b/i, '')) || 0
  const nb = Number(String(b || '').replace(/^b/i, '')) || 0
  return na === nb ? 0 : na > nb ? 1 : -1
}

export function declaredLlamaBuild() {
  return LLAMACPP_BUILD
}

/** 已安装的 llama.cpp 构建（目录名 <variant>-bXXXXX 里最大的那个） */
export function installedLlamaBuild(runtimeRoot) {
  let best = ''
  try {
    for (const name of fs.readdirSync(runtimeRoot)) {
      const m = /^llamacpp-(?:vulkan|rocm|cuda)-b(\d+)$/.exec(name)
      if (!m) continue
      const tag = 'b' + m[1]
      if (!best || compareBuild(tag, best) > 0) best = tag
    }
  } catch { /* 没有目录 */ }
  return best || declaredLlamaBuild()
}

/** 本机 flm.exe 的版本（flm version -j → {"version":"1.0.10"}） */
export function localFlmVersion(flmExe) {
  return new Promise((resolve) => {
    if (!flmExe) return resolve('')
    let out = ''
    let child
    try { child = spawnQuiet(flmExe, ['version', '-j']) } catch { return resolve('') }
    if (!child) return resolve('')
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolve('') }, 8000)
    child.stdout.on('data', (c) => { out += c })
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('exit', () => {
      clearTimeout(timer)
      try { resolve(String(JSON.parse(out).version || '')) } catch { resolve('') }
    })
  })
}

function spawnQuiet(exe, args) {
  return childSpawn(exe, args, { windowsHide: true })
}

/** FLM 最新 Release */
export async function flmRelease(mirror) {
  const j = await getJson(`${API}/repos/${FLM_REPO}/releases/latest`)
  const version = String(j.tag_name || '').replace(/^v/i, '')
  const win = (j.assets || []).filter((a) => /fastflowlm_.*windows_amd64\.zip$/i.test(a.name))
  const asset = win[0] || (j.assets || []).find((a) => /windows.*\.zip$/i.test(a.name))
  return {
    id: 'flm', label: 'FastFlowLM (AMD NPU)', version,
    page: FLM_PAGE,
    asset: asset ? {
      name: asset.name, size: asset.size, sha256: digestOf(asset),
      url: withMirror(asset.browser_download_url, mirror),
      rawUrl: asset.browser_download_url,
    } : null,
  }
}

/** llama.cpp 最新 nightly（bXXXXX）Release 与 Windows 包 */
export async function llamaRelease(mirror) {
  // 先看最近的 Release 里有没有 bXXXXX 标签（v0.8.0 那种里程碑版没有 Windows 包）
  const list = await getJson(`${API}/repos/${LLAMA_REPO}/releases?per_page=10`)
  const nightly = (list || []).find((r) => /^b\d+$/.test(String(r.tag_name || '')))
  const build = nightly ? String(nightly.tag_name) : ''
  const assets = {}
  if (nightly) {
    for (const [id, variant] of Object.entries(VARIANTS)) {
      const file = `llama-${build}-bin-win-${variant}-x64.zip`
      const asset = (nightly.assets || []).find((a) => a.name === file)
      if (asset) {
        assets[id] = {
          name: asset.name, size: asset.size, sha256: digestOf(asset),
          url: withMirror(asset.browser_download_url, mirror),
          rawUrl: asset.browser_download_url,
        }
      }
    }
  }
  return { id: 'llamacpp', label: 'llama.cpp', build, page: LLAMA_PAGE, assets }
}

function digestOf(asset) {
  const d = String((asset && asset.digest) || '')
  return d.startsWith('sha256:') ? d.slice(7) : ''
}

/**
 * 检查两个框架的更新。
 * @returns {Promise<{checkedAt:number, items:Array, errors:Array, mirror:string}>}
 */
export async function checkFrameworkUpdates(opts = {}) {
  const mirror = opts.mirror || ''
  const flmExe = opts.flmExe || ''
  const runtimeRoot = opts.runtimeRoot || ''
  const items = []
  const errors = []
  const [flmRes, llamaRes, flmLocal, llamaLocal] = await Promise.allSettled([
    flmRelease(mirror),
    llamaRelease(mirror),
    localFlmVersion(flmExe),
    Promise.resolve(installedLlamaBuild(runtimeRoot)),
  ])

  if (flmRes.status === 'fulfilled') {
    const rel = flmRes.value
    const current = flmLocal.status === 'fulfilled' ? flmLocal.value : ''
    const latest = rel.version
    const available = !!(rel.asset && latest && (!current || compareVersions(latest, current) > 0))
    items.push({
      id: 'flm', label: rel.label, kind: 'flm',
      current: current || '（未检测到 flm.exe）', latest,
      available, page: rel.page, asset: rel.asset,
      note: rel.asset ? '' : '官方 Release 没有 Windows 可执行包，只能打开下载页手动更新',
    })
  } else {
    errors.push({ id: 'flm', error: String(flmRes.reason && flmRes.reason.message || flmRes.reason) })
    items.push({ id: 'flm', label: 'FastFlowLM (AMD NPU)', kind: 'flm', current: '', latest: '', available: false, page: FLM_PAGE, asset: null, checked: false })
  }

  if (llamaRes.status === 'fulfilled') {
    const rel = llamaRes.value
    const current = llamaLocal.status === 'fulfilled' ? llamaLocal.value : declaredLlamaBuild()
    const latest = rel.build
    const available = !!(latest && Object.keys(rel.assets).length && compareBuild(latest, current) > 0)
    items.push({
      id: 'llamacpp', label: 'llama.cpp', kind: 'llamacpp',
      current, latest: latest || declaredLlamaBuild(), available, page: rel.page, assets: rel.assets,
      note: Object.keys(rel.assets).length ? '' : '最新 Release 里没有 Windows 包，只能打开下载页手动更新',
    })
  } else {
    errors.push({ id: 'llamacpp', error: String(llamaRes.reason && llamaRes.reason.message || llamaRes.reason) })
    items.push({ id: 'llamacpp', label: 'llama.cpp', kind: 'llamacpp', current: declaredLlamaBuild(), latest: '', available: false, page: LLAMA_PAGE, assets: {}, checked: false })
  }

  return { checkedAt: Date.now(), items, errors, mirror }
}

/* ------------------------------------------------------------ 下载/安装 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 分块 Range 下载。
 * 实测 Node 的 fetch 在直连 GitHub release 大文件时偶尔会在几 MB 后卡死（PowerShell/浏览器正常），
 * 用 Range 分 4MB 拉取 + 每块重试，既稳又能续传，进度也更平滑。
 */
async function downloadTo(url, dest, onProgress) {
  const tmp = dest + '.part'
  const CHUNK = 4 * 1024 * 1024
  // 用 0-0 的 Range 问总大小（同时验证服务端支持 Range）
  let total = 0
  try {
    const probe = await fetch(url, { headers: { 'user-agent': UA, range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(30000) })
    const cr = probe.headers.get('content-range') || ''
    const m = /\/(\d+)\s*$/.exec(cr)
    if (m) total = Number(m[1])
    try { await probe.arrayBuffer() } catch { /* ignore */ }
  } catch { /* 探测失败走普通下载 */ }

  if (total > 0) {
    fs.writeFileSync(tmp, Buffer.alloc(0))
    let got = 0
    while (got < total) {
      const start = got
      const end = Math.min(start + CHUNK - 1, total - 1)
      let ok = false
      let lastErr = null
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const res = await fetch(url, {
            headers: { 'user-agent': UA, range: `bytes=${start}-${end}` },
            redirect: 'follow',
            signal: AbortSignal.timeout(120000),
          })
          if (res.status !== 206 && res.status !== 200) throw new Error('HTTP ' + res.status)
          const buf = Buffer.from(await res.arrayBuffer())
          if (!buf.length) throw new Error('空分块')
          fs.appendFileSync(tmp, buf)
          got += buf.length
          if (onProgress) onProgress(got, total)
          ok = true
        } catch (e) {
          lastErr = e
          await sleep(400 * (attempt + 1))
        }
      }
      if (!ok) {
        try { fs.unlinkSync(tmp) } catch { /* ignore */ }
        throw new Error(`下载中断（已下 ${(got / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB）：${(lastErr && lastErr.message) || lastErr}`)
      }
    }
    fs.renameSync(tmp, dest)
    return { bytes: got, total }
  }

  // 服务端不支持 Range：退回普通流式
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const out = fs.createWriteStream(tmp)
  const reader = res.body.getReader()
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    got += value.length
    if (onProgress) onProgress(got, total)
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r))
  }
  await new Promise((r) => out.end(r))
  fs.renameSync(tmp, dest)
  return { bytes: got, total }
}

const MIRROR_FALLBACK = ['https://gh-proxy.com/', 'https://ghfast.top/']
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

/** 下载一个 asset：自定义镜像优先，其次直连，最后尝试内置镜像；sha256 在安装阶段统一校验 */
async function downloadAsset(rawUrl, mirror, dest, onProgress) {
  const tried = []
  const candidates = []
  if (mirror) candidates.push(withMirror(rawUrl, mirror))
  candidates.push(rawUrl)
  for (const m of MIRROR_FALLBACK) candidates.push(withMirror(rawUrl, m))
  const uniq = [...new Set(candidates)]
  let lastErr = null
  for (const url of uniq) {
    try {
      const r = await downloadTo(url, dest, onProgress)
      return { ...r, via: url === rawUrl ? 'direct' : url }
    } catch (e) {
      lastErr = e
      tried.push((url === rawUrl ? 'direct' : url) + ': ' + ((e && e.message) || e))
      if (onProgress) onProgress(0, 0)
    }
  }
  throw new Error('下载失败（直连与镜像都不可用）：' + tried.join('；') + '。可在面板「下载镜像」里填一个可用前缀，例如 https://gh-proxy.com/')
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

function unzip(zip, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dest, { recursive: true })
    execFile('tar', ['-xf', zip, '-C', dest], { windowsHide: true, timeout: 600000 }, (err) => {
      if (err) return reject(new Error('解压失败：' + err.message))
      resolve()
    })
  })
}

function findFile(dir, nameRe) {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isFile() && nameRe.test(e.name)) return full
      if (e.isDirectory()) stack.push(full)
    }
  }
  return ''
}

/** 安装 FLM 更新包（下载 → 校验 → 解压 → <dataRoot>/frameworks/flm-<ver>） */
export async function installFlmUpdate(opts = {}) {
  const { dataRoot, asset, version, onProgress, mirror } = opts
  if (!dataRoot) throw new Error('缺 dataRoot')
  if (!asset || !asset.url) throw new Error('没有可下载的 FLM 更新包')
  const dest = path.join(dataRoot, 'frameworks', 'flm-' + version)
  const exeName = process.platform === 'win32' ? /^flm\.exe$/i : /^flm$/i
  const existing = findFile(dest, exeName)
  if (existing) return { exe: existing, version, already: true }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const zip = path.join(path.dirname(dest), asset.name)
  if (!fs.existsSync(zip) || (asset.size && fs.statSync(zip).size !== asset.size)) {
    await downloadAsset(asset.url, mirror, zip, onProgress)
  }
  if (asset.sha256) {
    const got = await sha256File(zip)
    if (got !== asset.sha256) {
      try { fs.unlinkSync(zip) } catch { /* ignore */ }
      throw new Error(`FLM 更新包 sha256 不匹配：拿到 ${got.slice(0, 12)}…`)
    }
  }
  const staging = dest + '.staging-' + Date.now()
  await unzip(zip, staging)
  const exe = findFile(staging, exeName)
  if (!exe) throw new Error('FLM 更新包里没找到 flm.exe（解压目录保留在 ' + staging + '）')
  // 包内可能有外层目录：把 flm.exe 所在的整个目录搬成版本目录
  const root = path.dirname(exe)
  const stamp = '.old-' + Date.now()
  // 不递归删除任何目录：旧目录改名保留，交给用户清理
  if (fs.existsSync(dest)) fs.renameSync(dest, dest + stamp)
  if (path.resolve(root) === path.resolve(staging)) {
    fs.renameSync(staging, dest)
  } else {
    fs.renameSync(root, dest)
    try { fs.renameSync(staging, staging + '.leftover') } catch { /* 保留即可 */ }
  }
  const finalExe = findFile(dest, exeName)
  if (!finalExe) throw new Error('迁移更新目录后找不到 flm.exe')
  return { exe: finalExe, version, downloaded: true }
}

/** 安装 llama.cpp 更新包（下载 → 校验 → 解压 → <dataRoot>/runtimes/<variant>-<build>） */
export async function installLlamaUpdate(opts = {}) {
  const { dataRoot, backendId, build, asset, onProgress, mirror } = opts
  if (!dataRoot) throw new Error('缺 dataRoot')
  if (!asset || !asset.url) throw new Error('这个后端没有对应的更新包')
  if (!VARIANTS[backendId]) throw new Error('未知 llama.cpp 后端：' + backendId)
  const dirName = `${backendId}-${build}`
  const dest = path.join(dataRoot, 'runtimes', dirName)
  const exeName = /^llama-server\.exe$/i
  const existing = findFile(dest, exeName)
  if (existing) return { exe: existing, build, already: true }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const zip = path.join(path.dirname(dest), asset.name)
  if (!fs.existsSync(zip) || (asset.size && fs.statSync(zip).size !== asset.size)) {
    await downloadAsset(asset.url, mirror, zip, onProgress)
  }
  if (asset.sha256) {
    const got = await sha256File(zip)
    if (got !== asset.sha256) {
      try { fs.unlinkSync(zip) } catch { /* ignore */ }
      throw new Error(`llama.cpp 更新包 sha256 不匹配：拿到 ${got.slice(0, 12)}…`)
    }
  }
  const staging = dest + '.staging-' + Date.now()
  await unzip(zip, staging)
  const exe = findFile(staging, exeName)
  if (!exe) throw new Error('更新包里没找到 llama-server.exe（解压目录保留在 ' + staging + '）')
  const root = path.dirname(exe)
  if (fs.existsSync(dest)) fs.renameSync(dest, dest + '.old-' + Date.now())
  if (path.resolve(root) === path.resolve(staging)) {
    fs.renameSync(staging, dest)
  } else {
    fs.renameSync(root, dest)
    try { fs.renameSync(staging, staging + '.leftover') } catch { /* 保留即可 */ }
  }
  const finalExe = findFile(dest, exeName)
  if (!finalExe) throw new Error('迁移更新目录后找不到 llama-server.exe')
  return { exe: finalExe, build, downloaded: true }
}

export const FRAMEWORK_PAGES = { flm: FLM_PAGE, llamacpp: LLAMA_PAGE }

/* ------------------------------------------------- 更新中心（状态 + 安装） */

/**
 * 框架更新状态机（从 index.js 拆出）。
 *
 * @param {{
 *   dataRoot: string,
 *   getFlmExe?: () => string,
 *   getMirror?: () => string,
 *   getBackendPref?: () => string,
 *   onInstalled?: (r:{id:string, exe:string, variant?:string}) => void,
 *   log?: Function,
 *   checkFn?: Function,          // 测试注入，默认 checkFrameworkUpdates
 *   installFlm?: Function,       // 测试注入
 *   installLlama?: Function,
 * }} opts
 */
export function createUpdateCenter(opts = {}) {
  const dataRoot = String(opts.dataRoot || '')
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const cacheFile = dataRoot ? path.join(dataRoot, 'framework-updates.json') : ''
  const checkFn = opts.checkFn || checkFrameworkUpdates
  const installFlm = opts.installFlm || installFlmUpdate
  const installLlama = opts.installLlama || installLlamaUpdate
  const empty = () => ({ checkedAt: 0, items: [], errors: [], mirror: '', checking: false })

  let state = (() => {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (cached && cached.checkedAt) return { ...empty(), ...cached, checking: false, cached: true }
    } catch { /* 没缓存 */ }
    return empty()
  })()
  let progress = null
  let checking = null

  function saveCache() {
    if (!cacheFile) return
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      const tmp = `${cacheFile}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify({ ...state, checking: false }, null, 2))
      fs.renameSync(tmp, cacheFile)
    } catch { /* 缓存写不了不影响 */ }
  }

  function item(id) {
    return (state.items || []).find((x) => x.id === id) || null
  }

  async function check(force = true) {
    if (checking) return checking
    state = { ...state, checking: true }
    checking = (async () => {
      try {
        const r = await checkFn({
          flmExe: typeof opts.getFlmExe === 'function' ? opts.getFlmExe() : '',
          runtimeRoot: dataRoot ? path.join(dataRoot, 'runtimes') : '',
          mirror: typeof opts.getMirror === 'function' ? opts.getMirror() : '',
        })
        state = { ...r, checking: false, cached: false }
        saveCache()
        const avail = (r.items || []).filter((x) => x.available).map((x) => `${x.label} ${x.current}→${x.latest}`)
        log(avail.length ? `框架更新可用：${avail.join('；')}` : '框架更新：已是最新')
      } catch (e) {
        state = { ...state, checking: false, errors: [{ id: 'all', error: String((e && e.message) || e) }] }
        log(`框架更新检查失败：${(e && e.message) || e}`)
      } finally {
        checking = null
      }
      return state
    })()
    return checking
  }

  /** 安装框架更新（只装到插件数据根，不覆盖用户手动安装的那份） */
  async function install(id, body) {
    const it = item(id)
    if (!it) throw new Error('未知框架：' + id)
    if (progress && progress.state === 'running') throw new Error('已有更新正在下载，请稍候')
    if (!it.available) throw new Error('没有可用更新；先点「检查更新」')
    progress = { id, state: 'running', got: 0, total: 0 }
    const onProgress = (got, total) => { progress = { id, state: 'running', got, total } }
    const mirror = typeof opts.getMirror === 'function' ? opts.getMirror() : ''
    try {
      let exe = ''
      let variant = ''
      if (id === 'flm') {
        if (!it.asset) throw new Error('官方 Release 没有 Windows 包，请用「打开下载页」手动更新')
        const r = await installFlm({ dataRoot, asset: it.asset, version: it.latest, onProgress, mirror })
        exe = r.exe
        log(`FLM 已更新到 ${it.latest}：${exe}`)
      } else if (id === 'llamacpp') {
        variant = String((body && body.variant) || '').startsWith('llamacpp-')
          ? String(body.variant)
          : (String(typeof opts.getBackendPref === 'function' ? opts.getBackendPref() : '').startsWith('llamacpp-')
            ? String(opts.getBackendPref()) : 'llamacpp-vulkan')
        const asset = it.assets && it.assets[variant]
        if (!asset) throw new Error('这个后端没有对应的更新包：' + variant)
        const r = await installLlama({ dataRoot, backendId: variant, build: it.latest, asset, onProgress, mirror })
        exe = r.exe
        log(`llama.cpp 已更新到 ${it.latest}（${variant}）：${exe}`)
      } else {
        throw new Error('未知框架：' + id)
      }
      progress = { id, state: 'done', got: 0, total: 0 }
      if (typeof opts.onInstalled === 'function') {
        try { opts.onInstalled({ id, exe, variant }) } catch (e) { log(`更新后应用配置失败：${(e && e.message) || e}`) }
      }
      await check(true).catch(() => {})
      return { id, exe, progress }
    } catch (e) {
      progress = { id, state: 'error', error: String((e && e.message) || e) }
      throw e
    }
  }

  return {
    state: () => ({ ...state, progress }),
    progress: () => progress,
    check,
    install,
    cacheFile: () => cacheFile,
  }
}




