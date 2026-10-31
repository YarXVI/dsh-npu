/**
 * 运行时管理：插件自己把后端二进制下载、校验、解压到自己的目录。
 *
 * 为什么要自己做：
 *   - 不依赖用户装 Ollama / LM Studio，也不要求用户手动放 exe；
 *   - 版本由插件锁定，出问题能对齐；
 *   - 解压后目录结构固定，spawn 时不用猜路径。
 *
 * 解压用系统自带的 tar（Win10+ 的 bsdtar 能解 zip），不引第三方依赖。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

const GITHUB = 'https://github.com/ggml-org/llama.cpp/releases/download'

/**
 * 已锁定的运行时清单。
 * sha256 用于校验下载完整性；换版本时三个字段一起改。
 * b11871 是 2026-10 实测可用的版本（Vulkan 包在本机 AMD 8060S 上跑通）。
 */
export const LLAMACPP_BUILD = 'b11871'

export const RUNTIMES = {
  'llamacpp-vulkan': {
    id: 'llamacpp-vulkan',
    kind: 'llamacpp',
    label: 'llama.cpp · Vulkan',
    note: 'AMD / Intel / NVIDIA 通吃，装它最稳',
    file: `llama-${LLAMACPP_BUILD}-bin-win-vulkan-x64.zip`,
    sizeMB: 35,
    sha256: '34a0366b9d9d22d09a58dd2958570f2549568067f3f15de771fc1909e888dd80',
    exe: 'llama-server.exe',
    // Vulkan 版是自包含的，不需要额外的运行库
    needs: [],
  },
  'llamacpp-cuda': {
    id: 'llamacpp-cuda',
    kind: 'llamacpp',
    label: 'llama.cpp · CUDA 12.4',
    note: 'NVIDIA 显卡专用，还要额外下 cudart 包',
    file: `llama-${LLAMACPP_BUILD}-bin-win-cuda-12.4-x64.zip`,
    sizeMB: 260,
    sha256: '',
    exe: 'llama-server.exe',
    needs: [`cudart-llama-bin-win-cuda-12.4-x64.zip`],
    sizeNote: '合计约 630 MB',
  },
  'llamacpp-rocm': {
    id: 'llamacpp-rocm',
    kind: 'llamacpp',
    label: 'llama.cpp · ROCm 10.0',
    note: 'AMD 显卡（独显支持较好，核显常常识别不到）',
    file: `llama-${LLAMACPP_BUILD}-bin-win-rocm-10.0-x64.zip`,
    sizeMB: 252,
    sha256: '',
    exe: 'llama-server.exe',
    needs: [],
  },
}

/**
 * @param {string} id 运行时 id
 * @param {string} [baseUrl] 下载源前缀；默认 GitHub。给镜像站或测试用
 */
export function urlOf(id, baseUrl) {
  const r = RUNTIMES[id]
  if (!r) throw new Error('未知运行时: ' + id)
  if (r.external || !r.file) throw new Error(`${id} 是外挂运行时，需要用户自己准备`)
  const base = baseUrl || GITHUB
  return `${base.replace(/\/+$/, '')}/${LLAMACPP_BUILD}/${r.file}`
}

export function extrasDir(root, id) {
  const r = RUNTIMES[id]
  const folder = (r && r.folder) || id
  return path.join(root, '..', 'extras', folder)
}

export function runtimeDir(root, id) {
  return path.join(root, `${id}-${LLAMACPP_BUILD}`)
}

/** 已经装好了吗（exe 存在）。会扫 <id>-bXXXXX 的所有构建，优先用最新的；
 *  这样「框架更新」装出来的新 build 不用改常量就能被选用。 */
export function installed(root, id) {
  const r = RUNTIMES[id]
  if (!r) return null
  if (r.external) {
    const exe = path.join(extrasDir(root, id), r.exe)
    return fs.existsSync(exe) ? exe : null
  }
  const found = []
  try {
    const re = new RegExp('^' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-b(\\d+)$')
    for (const name of fs.readdirSync(root)) {
      const m = re.exec(name)
      if (m) found.push({ dir: path.join(root, name), build: Number(m[1]) })
    }
  } catch { /* 目录不存在 */ }
  const pinned = runtimeDir(root, id)
  if (!found.some((x) => x.dir === pinned)) {
    found.push({ dir: pinned, build: Number(String(LLAMACPP_BUILD).replace(/\D/g, '')) || 0 })
  }
  found.sort((a, b) => b.build - a.build)
  for (const item of found) {
    const exe = path.join(item.dir, r.exe)
    if (fs.existsSync(exe)) return exe
  }
  return null
}

function fetchToFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part'
    const out = fs.createWriteStream(tmp)
    let received = 0
    let total = 0

    const done = (err) => {
      out.close(() => {
        if (err) { try { fs.unlinkSync(tmp) } catch { /* ignore */ } return reject(err) }
        try { fs.renameSync(tmp, dest) } catch (e) { return reject(e) }
        resolve({ bytes: received, total })
      })
    }

    // Node 18+ 自带 fetch，用流式写盘避免把几百 MB 读进内存
    fetch(url, { redirect: 'follow' }).then((res) => {
      if (!res.ok) return done(new Error(`下载失败 HTTP ${res.status} ${url}`))
      total = Number(res.headers.get('content-length') || 0)
      const reader = res.body.getReader()
      const pump = () => reader.read().then(({ done: fin, value }) => {
        if (fin) return done(null)
        received += value.length
        if (onProgress) onProgress(received, total)
        if (!out.write(Buffer.from(value))) { out.once('drain', pump); return }
        pump()
      }).catch(done)
      pump()
    }).catch(done)
  })
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

function untar(zip, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dest, { recursive: true })
    // Windows 10+ 自带 bsdtar，能直接解 zip，省掉 npm 依赖
    execFile('tar', ['-xf', zip, '-C', dest], { windowsHide: true, timeout: 300000 }, (err) => {
      if (err) return reject(new Error('解压失败：' + err.message))
      resolve()
    })
  })
}

/**
 * 确保某个运行时可用；缺就下载 + 校验 + 解压。
 * @returns {Promise<{exe: string, downloaded: boolean}>}
 */
export async function ensureRuntime(id, opts = {}) {
  const r = RUNTIMES[id]
  if (!r) throw new Error('未知运行时: ' + id)

  const root = opts.root || path.join(process.cwd(), 'runtimes')
  const already = installed(root, id)
  if (already) return { exe: already, downloaded: false }

  if (r.external) {
    throw new Error(r.hint || '这个运行时需要你自己准备')
  }

  const dir = runtimeDir(root, id)
  await fsp.mkdir(dir, { recursive: true })

  const base = opts.baseUrl || GITHUB
  const downloads = [r.file, ...(r.needs || [])]
  for (const file of downloads) {
    const url = `${base.replace(/\/+$/, '')}/${LLAMACPP_BUILD}/${file}`
    const dest = path.join(dir, file)
    if (!fs.existsSync(dest)) {
      if (opts.log) opts.log(`下载 ${file} …`)
      await fetchToFile(url, dest, opts.onProgress)
    }
    // 主包有 sha256 就校验，避免下到半截或代理返回 HTML
    const expect = file === r.file ? (opts.sha256 || r.sha256) : ''
    if (expect) {
      const got = await sha256File(dest)
      if (got !== expect) {
        try { fs.unlinkSync(dest) } catch { /* ignore */ }
        throw new Error(`校验失败：${file} 的 sha256 不匹配（拿到 ${got.slice(0, 12)}…）`)
      }
    }
    await untar(dest, dir)
  }

  const exe = path.join(dir, r.exe)
  if (!fs.existsSync(exe)) throw new Error(`解压后找不到 ${r.exe}（${dir}）`)
  return { exe, downloaded: true }
}

/** 删掉某个运行时的目录（换版本 / 清理磁盘） */
export async function removeRuntime(id, opts = {}) {
  const root = opts.root || path.join(process.cwd(), 'runtimes')
  await fsp.rm(runtimeDir(root, id), { recursive: true, force: true })
}
