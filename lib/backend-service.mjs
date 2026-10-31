/**
 * 后端服务：把「探测 → 排链 → 选后端 → 配模型」串起来，给面板和 supervisor 用。
 *
 * 三条已经定下来的约束：
 *   - CUDA 不随插件下载，用户自己放 extras/ 里
 *   - 模型不预装，只扫 mods/ 目录里的 .gguf
 *   - 任何下载只走镜像（hf-mirror / 魔搭），不直连 huggingface.co
 */
import fs from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import path from 'node:path'
import { detectHardware } from './detect.mjs'
import { planBackends, describePlan } from './policy.mjs'
import { pickBackend } from './select.mjs'
import { scanMods, findModel, ensureModsDir, MODS_DIRNAME } from './mods.mjs'
import { RUNTIMES, installed, removeRuntime, urlOf, ensureRuntime } from './runtimes.mjs'
import { mirrorUrls, normalizeSource, isDirectHuggingFace } from './mirrors.mjs'
import { timestamp } from './config.mjs'
import { readFlmCatalog } from './probe.mjs'

/* --------------------------------------------------------- 回收站（不真删） */

/**
 * 把模型/运行时移进 `<dataRoot>/trash/<时间戳>/`（契约 §0.5：不删用户数据）。
 * 跨盘时先完整复制、成功后再移除原目录；任何步骤失败都保留了原数据。
 * @returns {string} 回收站里的新路径
 */
export function moveToTrash(dataRoot, target, opts = {}) {
  const root = String(dataRoot || '').trim()
  if (!root) throw new Error('没有数据根，无法移到回收站')
  if (!target) throw new Error('缺目标路径')
  const src = path.resolve(target)
  const trashBase = path.join(root, 'trash')
  const destDir = path.join(trashBase, timestamp())
  fs.mkdirSync(destDir, { recursive: true })
  const base = path.basename(src)
  let dest = path.join(destDir, base)
  let n = 2
  while (fs.existsSync(dest)) { dest = path.join(destDir, `${base}-${n}`); n += 1 }
  try {
    fs.renameSync(src, dest)
  } catch (e) {
    if (!(e && (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EACCES'))) throw e
    // 跨卷：复制完成后再移除原路径，复制失败则原数据保持不动
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false })
    fs.rmSync(src, { recursive: true, force: true })
  }
  return dest
}

function runCmd(exe, args, timeoutMs, env) {
  return new Promise((resolve, reject) => {
    let out = ''
    let done = false
    const child = spawn(exe, args, { windowsHide: true, env: { ...process.env, ...(env || {}) } })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { child.kill() } catch { /* ignore */ }
      reject(new Error('命令超时：' + exe + ' ' + args.join(' ')))
    }, timeoutMs || 60000)
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(Exception_message(e)))
    })
    child.on('exit', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error('命令失败（exit ' + code + '）：' + out.slice(0, 300)))
    })
  })
}

function Exception_message(e) {
  return (e && e.message) ? e.message : String(e)
}

export class BackendService {
  constructor(opts = {}) {
    this.root = opts.root || path.join(process.cwd(), 'data')
    this.pref = opts.pref || 'auto'     // auto | flm | llamacpp-vulkan | llamacpp-cuda
    this.flmExe = opts.flmExe || ''     // 用户自己装的 flm.exe
    this.runtimeRoot = opts.runtimeRoot || path.join(this.root, 'runtimes')
    this.log = opts.log || (() => {})
    this.hw = null
    this.plan = null
    this.chosen = null
    this.exe = null
    this.skipped = []
    this.devices = []
    this.resolvedAt = 0
    this.download = null      // { file, got, total, state, error }
  }

  modsDir() {
    const dir = ensureModsDir(this.root)
    // 一次性的目录整理：mods/*.gguf → mods/llamacpp/*.gguf
    try {
      const llamaDir = path.join(dir, 'llamacpp')
      fs.mkdirSync(llamaDir, { recursive: true })
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isFile() || !/\.gguf$/i.test(e.name)) continue
        try { fs.renameSync(path.join(dir, e.name), path.join(llamaDir, e.name)) } catch { /* 占用就跳过 */ }
      }
    } catch { /* ignore */ }
    return dir
  }

  listModels() {
    const main = scanMods(this.llamaModsDir())
    if (main.length) return main
    // 兼容旧版：模型直接放在 mods/ 根下
    return scanMods(this.modsDir()).filter((m) => !m.path.includes(path.sep + 'flm' + path.sep))
  }

  /** 探测硬件并排链（不下载、不启动） */
  async inspect() {
    this.hw = await detectHardware()
    this.plan = planBackends(this.hw)
    return {
      hardware: this.hw,
      plan: this.plan,
      summary: describePlan(this.plan),
      modsDir: this.modsDir(),
    }
  }

  /**
   * 选定后端：会按链子逐个尝试（必要时下载 Vulkan 运行时）。
   * @returns {Promise<{chosen, exe, skipped, devices}>}
   */
  async resolve(force) {
    if (!force && this.chosen && Date.now() - this.resolvedAt < 60000) {
      return { chosen: this.chosen, exe: this.exe, skipped: this.skipped, devices: this.devices }
    }
    if (!this.plan) await this.inspect()
    const r = await pickBackend(this.plan, {
      root: this.runtimeRoot,
      pref: this.pref,
      flmExe: this.flmExe,
      log: this.log,
      onProgress: (got, total) => { this.download = { file: 'runtime', got, total, state: 'running' } },
    })
    this.chosen = r.chosen
    this.exe = r.exe
    this.skipped = r.skipped
    this.devices = r.devices
    this.resolvedAt = Date.now()
    return r
  }

  /**
   * FLM 实际读的模型目录。
   * FLM 1.0.x 的约定是 `<FLM_MODEL_PATH>/models/<HF 仓库名>/<模型文件>`，
   * 默认根是 C:\Users\<user>\.flm；插件把模型放在 <数据根>/mods/flm（扁平布局），
   * 由 flmHome() 建目录联接接上。
   */
  flmDir() {
    const env = process.env.FLM_MODEL_PATH
    if (env) {
      const models = path.join(env, 'models')
      try { if (fs.existsSync(models)) return models } catch { /* ignore */ }
      return env
    }
    return path.join(this.modsDir(), 'flm')
  }

  /** FLM 自己的默认根（C:\Users\<user>\.flm） */
  flmHomeDir() {
    return path.join(process.env.USERPROFILE || process.env.HOME || '.', '.flm')
  }

  /**
   * 给 FLM 准备「模型根」：<数据根>/flm-home/models → <数据根>/mods/flm 的目录联接。
   * 这样 FLM 能直接看到数据根里的模型，既不搬数据、也不动用户主目录。
   * 失败时返回 ''（调用方退回 FLM 默认目录）。
   */
  flmHome() {
    if (this._flmHome !== undefined) return this._flmHome
    const target = path.join(this.modsDir(), 'flm')
    const home = path.join(this.root, 'flm-home')
    const link = path.join(home, 'models')
    try {
      fs.mkdirSync(home, { recursive: true })
      fs.mkdirSync(target, { recursive: true })
      let linked = false
      try {
        const st = fs.lstatSync(link)
        if (st.isSymbolicLink()) linked = true
        else if (st.isDirectory()) {
          // 空目录可以先删掉再建联接；非空说明用户有自己的布局，不去动它
          try { fs.rmdirSync(link); fs.symlinkSync(target, link, 'junction'); linked = true } catch { linked = false }
        }
      } catch {
        fs.symlinkSync(target, link, 'junction')
        linked = true
      }
      this._flmHome = linked ? home : ''
    } catch (e) {
      if (this.log) this.log('FLM 模型目录联接失败：' + ((e && e.message) || e))
      this._flmHome = ''
    }
    return this._flmHome
  }

  /** 给 flm 子进程的环境变量：让 list / serve 看到同一份模型 */
  flmSpawnEnv() {
    const home = this.flmHome()
    return home ? { FLM_MODEL_PATH: home } : {}
  }

  /** FLM 进程在不在（改目录联接前必须停掉） */
  flmRunning() {
    return new Promise((resolve) => {
      const child = spawn('tasklist', ['/FI', 'IMAGENAME eq flm.exe', '/NH'], { windowsHide: true })
      let out = ''
      child.stdout.on('data', (c) => { out += c })
      child.on('error', () => resolve(false))
      child.on('exit', () => resolve(/flm\.exe/i.test(out)))
    })
  }

  /**
   * 让用户的 FLM（CLI / 其它软件）也能找到数据根里的模型：
   * 在 C:\Users\<user>\.flm\models 建一个指向 <数据根>/mods/flm 的目录联接。
   *
   * 安全约束（本机有过 .dsh 被递归删除的事故）：
   *   - 绝不递归删除任何用户目录；
   *   - 已有真实模型目录时先 robocopy 拷到数据根，再把旧目录改名成 `.bak-<时间戳>` 留着；
   *   - 两边都有内容就拒绝，交给人处理。
   */
  async linkFlmHome(onProgress) {
    if (process.env.FLM_MODEL_PATH) {
      return { ok: true, external: true, note: '已由环境变量 FLM_MODEL_PATH 指定：' + process.env.FLM_MODEL_PATH }
    }
    if (await this.flmRunning()) {
      throw new Error('FLM 正在运行，先停掉它（或重启 DSH）再改模型目录')
    }
    const target = path.join(this.modsDir(), 'flm')
    const home = this.flmHomeDir()
    const link = path.join(home, 'models')
    fs.mkdirSync(target, { recursive: true })

    const samePath = (a, b) => {
      try { return path.resolve(fs.realpathSync(a)) === path.resolve(fs.realpathSync(b)) } catch { return false }
    }
    let backup = ''
    let copied = false
    try {
      const st = fs.lstatSync(link)
      if (st.isSymbolicLink()) {
        if (samePath(link, target)) return { ok: true, already: true, link, target }
        try { fs.unlinkSync(link) } catch { throw new Error('已有别的模型联接，先手动处理：' + link) }
      } else if (st.isDirectory()) {
        const linkEmpty = fs.readdirSync(link).length === 0
        const targetEmpty = fs.readdirSync(target).length === 0
        if (!linkEmpty && !targetEmpty) {
          throw new Error(`两个目录都有模型，不敢自动合并：${link} / ${target}`)
        }
        if (!linkEmpty) {
          // 拷到数据根（robocopy /E，退出码 < 8 都算成功）
          await new Promise((resolve, reject) => {
            execFile('robocopy', [link, target, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:2', '/W:1'],
              { windowsHide: true, timeout: 1800000 }, (err) => {
                const code = err ? err.code : 0
                if (err && code >= 8) return reject(new Error('robocopy 失败 code=' + code))
                resolve()
              })
          })
          copied = true
          if (onProgress) onProgress('copied')
        }
        // 旧目录改名保留（不删除），腾出位置建联接
        backup = link + '.bak-' + Date.now()
        fs.renameSync(link, backup)
      } else {
        fs.unlinkSync(link)   // 普通文件（不该出现），删掉这一个文件即可
      }
    } catch (e) {
      if (e && e.code === 'ENOENT') { /* 不存在，正常 */ }
      else if (e && e.message) throw e
    }
    fs.mkdirSync(home, { recursive: true })
    try {
      fs.symlinkSync(target, link, 'junction')
    } catch (e) {
      // 建联接失败：把备份改回去，别把用户数据卡在中间状态
      if (backup) { try { fs.renameSync(backup, link) } catch { /* ignore */ } }
      throw new Error('建立目录联接失败，已回滚：' + ((e && e.message) || e))
    }
    if (onProgress) onProgress('done')
    return { ok: true, link, target, backup, copied }
  }

  /** 兼容旧 API 名：面板的 /flm/migrate 仍可用 */
  async migrateFlmDir(onProgress) {
    return this.linkFlmHome(onProgress)
  }

  /** llama.cpp 三个包共用的模型目录 */
  llamaModsDir() {
    return path.join(this.modsDir(), 'llamacpp')
  }

  /** 某个后端该去哪个目录导入模型：FLM 与 llama 分开，互不混放 */
  modelsDirOf(id) {
    if (id === 'flm') return this.flmDir()
    return this.llamaModsDir()
  }

  /**
   * 打开某个后端的模型目录（资源管理器）。
   * 目录不存在就先建出来，免得 explorer 报错。
   */
  openModelsDir(id) {
    const dir = this.modelsDirOf(id)
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 建不了就让 explorer 自己报 */ }
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    return dir
  }

  /**
   * FLM 的模型目录（`<flmDir>/<repo>/`，可能多一层），按 tag / 目录名匹配。
   * 只用于「移到回收站」，匹配不到就拒绝，不猜、不删。
   */
  locateFlmModelDir(tag) {
    const want = String(tag || '').trim()
    if (!want) return ''
    const dirs = []
    const dir = this.flmDir()
    const pushIfModel = (d) => {
      try {
        const names = fs.readdirSync(d)
        if (names.some((n) => /^(model\.q4nx|configuration\.json|config\.json)$/i.test(n))) dirs.push(d)
      } catch { /* ignore */ }
    }
    let top = []
    try { top = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { /* ignore */ }
    for (const e of top) {
      const full = path.join(dir, e.name)
      pushIfModel(full)
      try {
        for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
          if (sub.isDirectory()) pushIfModel(path.join(full, sub.name))
        }
      } catch { /* ignore */ }
    }
    const norm = (s) => s.toLowerCase().replace(/[-_:\s]/g, '')
    const catalog = readFlmCatalog(this.flmExe || '')
    const hit = catalog.find((c) => norm(c.id) === norm(want))
    const candidates = [hit && hit.dirName, want, want.replace(/:/g, '-')].filter(Boolean).map((s) => String(s).toLowerCase())
    return dirs.find((d) => candidates.includes(path.basename(d).toLowerCase())) || ''
  }

  /**
   * 删掉某个后端下面的一个模型 —— **移到回收站**，不真删（契约 §0.5）。
   *   - llama.cpp：`<dataRoot>/trash/<ts>/<file>`
   *   - FLM：找到模型目录后整体移到回收站；找不到就拒绝（不执行 flm remove）
   * @returns {Promise<{ok:boolean, movedTo:string, removed:string}>}
   */
  async deleteModel(backendId, name) {
    const target = String(name || '').trim()
    if (!target) throw new Error('缺模型名')

    if (backendId === 'flm') {
      const dir = this.locateFlmModelDir(target)
      if (!dir) {
        throw new Error(`没找到 FLM 模型目录「${target}」；为避免误删，插件不会调用 flm remove。可在文件资源管理器里手动处理。`)
      }
      const movedTo = moveToTrash(this.root, dir)
      this.chosen = null
      this.resolvedAt = 0
      return { ok: true, movedTo, removed: target }
    }

    // llama.cpp：只允许处理 mods 目录内的文件
    const mods = this.llamaModsDir()
    const models = this.listModels()
    const hit = findModel(models, target)
    if (!hit) throw new Error('mods 里没有这个模型：' + target)

    const resolved = path.resolve(hit.path)
    const root = path.resolve(mods) + path.sep
    if (!resolved.startsWith(root)) throw new Error('拒绝处理 mods 目录之外的文件')

    const movedTo = moveToTrash(this.root, resolved)
    this.chosen = null
    this.resolvedAt = 0
    return { ok: true, movedTo, removed: hit.file }
  }

  backendStates() {
    const list = []
    list.push({
      id: 'flm',
      label: 'FastFlowLM',
      note: '默认框架 · AMD NPU 原生',
      kind: 'builtin',
      installed: !!(this.flmExe && fs.existsSync(this.flmExe)),
      exe: this.flmExe || '',
      sizeMB: 0,
      canDownload: false,
      modelsDir: this.flmDir(),
      models: [],
    })
    const ggufs = this.listModels()
    for (const [id, r] of Object.entries(RUNTIMES)) {
      const exe = installed(this.runtimeRoot, id)
      list.push({
        id,
        label: r.label,
        note: r.note || '',
        kind: 'addon',
        installed: !!exe,
        exe: exe || '',
        sizeMB: r.sizeMB,
        sizeNote: r.sizeNote || '',
        canDownload: true,
        modelsDir: this.modsDir(),
        models: ggufs.map((m) => ({
          id: m.path,
          name: m.file,
          meta: [m.sizeMB + ' MB', m.quant, m.params].filter(Boolean).join(' · '),
          kind: 'gguf',
        })),
        downloading: this.download && this.download.runtime === id && this.download.state === 'running',
        progress: this.download && this.download.runtime === id ? this.download : null,
      })
    }
    return list
  }

  /** 下载指定附加包（面板上的「下载」按钮） */
  async downloadRuntime(id, onProgress) {
    const r = RUNTIMES[id]
    if (!r) throw new Error('没有这个附加包：' + id)
    this.download = { runtime: id, state: 'running', got: 0, total: 0 }
    try {
      const out = await ensureRuntime(id, {
        root: this.runtimeRoot,
        log: this.log,
        onProgress: (got, total) => {
          this.download = { runtime: id, state: 'running', got, total }
          if (onProgress) onProgress(got, total)
        },
      })
      this.download = { runtime: id, state: 'done', got: 0, total: 0 }
      this.chosen = null
      this.resolvedAt = 0
      return out
    } catch (e) {
      this.download = { runtime: id, state: 'error', error: String(e && e.message || e) }
      throw e
    }
  }

  /** 删掉某个附加包（腾磁盘） */
  async removeAddon(id) {
    await removeRuntime(id, { root: this.runtimeRoot })
    this.chosen = null
    this.resolvedAt = 0
    return { ok: true }
  }

  /** 某个附加包的下载地址（面板可以显示或复制） */
  urlOf(id) {
    return urlOf(id)
  }

  /** 改手动偏好（面板用）：立即作废已选结果 */
  setPref(pref) {
    this.pref = pref || 'auto'
    this.chosen = null
    this.exe = null
    this.skipped = []
    this.devices = []
    this.resolvedAt = 0
  }

  /** 后端对应的 slot 定义（llama.cpp 用用户选的 gguf；FLM 保持原样由调用方决定） */
  slotFor(backendId, modelPath, opts = {}) {
    if (!backendId) return null
    if (backendId.startsWith('llamacpp')) {
      if (!modelPath) return null
      return {
        id: 'main',
        model: modelPath,
        name: path.basename(modelPath).replace(/\.gguf$/i, ''),
        contextWindow: opts.contextWindow || 8192,
        idleSec: opts.idleSec == null ? 180 : opts.idleSec,
        // 新槽位必须是启用、且参与 provider 的；否则会继承上一个槽位的 enabled:false
        enabled: true,
        llm: true,
        embed: false,
        alsoServes: [],
        think: true,
        reusePort: 0,
        args: ['-m', '{model}', '--port', '{port}', '--host', '127.0.0.1',
          '-c', String(opts.contextWindow || 8192), '-ngl', 'all', '--no-webui'],
      }
    }
    return null
  }

  /**
   * 从镜像下载一个模型到 mods/。
   * @param {{repo?:string, file?:string, url?:string}} req
   */
  async downloadModel(req, onProgress) {
    let url = ''
    let name = req && req.file

    if (req && req.url) {
      const norm = normalizeSource(req.url)
      if (isDirectHuggingFace(norm.url)) throw new Error('不允许直连 huggingface.co，请用镜像地址')
      url = norm.url
      if (!name) name = decodeURIComponent(url.split('?')[0].split('/').pop() || '')
    } else if (req && req.repo && req.file) {
      const urls = mirrorUrls(req.repo, req.file)
      url = urls[0].url
    } else {
      throw new Error('需要 repo + file，或者一个镜像 url')
    }

    if (!/\.gguf$/i.test(name || '')) throw new Error('只支持 .gguf 文件')
    const dir = this.llamaModsDir()
    const dest = path.join(dir, name)
    if (fs.existsSync(dest)) return { ok: true, file: dest, skipped: true }

    this.download = { file: name, got: 0, total: 0, state: 'running' }
    const tmp = dest + '.part'
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) {
      this.download = { file: name, state: 'error', error: `HTTP ${res.status}` }
      throw new Error(`下载失败 HTTP ${res.status}`)
    }
    const total = Number(res.headers.get('content-length') || 0)
    const out = fs.createWriteStream(tmp)
    const reader = res.body.getReader()
    let got = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        got += value.length
        this.download = { file: name, got, total, state: 'running' }
        if (onProgress) onProgress(got, total)
        if (!out.write(Buffer.from(value))) {
          await new Promise((r) => out.once('drain', r))
        }
      }
      await new Promise((r) => out.end(r))
      fs.renameSync(tmp, dest)
    } catch (e) {
      try { out.destroy() } catch { /* ignore */ }
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      this.download = { file: name, state: 'error', error: String(e && e.message || e) }
      throw e
    }
    this.download = { file: name, got, total, state: 'done' }
    return { ok: true, file: dest, sizeMB: Math.round(got / 1048576) }
  }

  /** 按名字在当前 mods 里找模型 */
  find(name) {
    return findModel(this.listModels(), name)
  }
}

export { MODS_DIRNAME, describePlan }
