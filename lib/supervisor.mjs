/**
 * NPU 模型的按需进程管理 + 本地代理
 *
 * 目标（对应「洁癖」需求）：
 *   1. 平时一个子进程都不存在，第一次请求才 spawn；
 *   2. 空闲 N 秒自动退出，NPU 归还；
 *   3. 所有子进程挂在 Windows Job Object 上，DSH 崩了/被 taskkill 也会被内核连带杀死，不留孤儿；
 *   4. 对外只暴露一个稳定端口，模型切换、按需启停对调用方透明。
 *
 * 用法：
 *   const sup = new NpuSupervisor({ exePath:'flm', slots:[...], frontPort:52630 })
 *   await sup.start()            // 只起代理，不起模型
 *   // 之后任何客户端打 http://127.0.0.1:52630/v1/... 即可，按 body.model 路由
 */

import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

/* ------------------------------------------------------------ Job Object */

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001

/**
 * 找 koffi：插件装在 profile 里时，profile 的 node_modules 没有它，
 * 但 DSH 安装目录的 app.asar.unpacked 里带着（原生模块必须解包）。
 */
function koffiCandidates(explicit) {
  const out = []
  if (explicit) out.push(explicit)
  out.push('koffi')
  const exeDir = process.execPath ? path.dirname(process.execPath) : ''
  const res = process.resourcesPath || (exeDir ? path.join(exeDir, 'resources') : '')
  if (res) {
    out.push(path.join(res, 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'))
    out.push(path.join(res, 'app.asar.unpacked', 'node_modules', 'koffi'))
  }
  if (exeDir) {
    out.push(path.join(exeDir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'))
  }
  return [...new Set(out)]
}

/**
 * 建一个 kill-on-close 的 Job。返回 { assign(pid), close() }；拿不到 koffi 时返回 null。
 */
export function createKillJob(koffiPath, log) {
  let koffi
  let used = null
  for (const p of koffiCandidates(koffiPath)) {
    try { koffi = require(p); used = p; break } catch { /* 继续试 */ }
  }
  if (!koffi) {
    if (log) log('koffi 不可用：Job Object 关闭，DSH 异常退出时可能留孤儿进程')
    return null
  }
  if (log) log(`koffi <- ${used}`)

  try {
    const k32 = koffi.load('kernel32.dll')
    const CreateJobObjectW = k32.func('void * CreateJobObjectW(void *lpJobAttributes, const char16_t *lpName)')
    const SetInformationJobObject = k32.func('bool SetInformationJobObject(void *hJob, int infoClass, void *info, uint32 len)')
    const AssignProcessToJobObject = k32.func('bool AssignProcessToJobObject(void *hJob, void *hProcess)')
    const OpenProcess = k32.func('void * OpenProcess(uint32 access, bool inherit, uint32 pid)')
    const CloseHandle = k32.func('bool CloseHandle(void *h)')

    const job = CreateJobObjectW(null, null)
    if (!job) return null

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION 在 x64 上是 144 字节，LimitFlags 位于偏移 16
    const info = Buffer.alloc(144)
    info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16)
    if (!SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.length)) {
      CloseHandle(job)
      return null
    }

    return {
      assign(pid) {
        const h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
        if (!h) return false
        const ok = AssignProcessToJobObject(job, h)
        CloseHandle(h)
        return !!ok
      },
      close() { try { CloseHandle(job) } catch { /* 进程已在退出 */ } }
    }
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- 工具 */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------- 主体 */

export class NpuSupervisor {
  /**
   * @param {{
   *   exePath: string,
   *   slots: Array<{id:string, model:string, args?:string[], embed?:boolean, idleSec?:number}>,
   *   frontPort?: number,
   *   readyTimeoutSec?: number,
   *   koffiPath?: string,
   *   log?: (msg:string, extra?:any)=>void
   * }} opts
   */
  constructor(opts) {
    this.opts = { readyTimeoutSec: 120, frontPort: 0, bindHost: '127.0.0.1', apiToken: '', log: () => {}, ...opts }
    this.slots = new Map()
    for (const s of opts.slots || []) {
      this.slots.set(s.id, {
        ...s,
        idleSec: s.idleSec ?? 60,
        proc: null,
        port: 0,
        ready: false,
        starting: null,
        busy: 0,
        lastUsed: 0,
        starts: 0
      })
    }
    this.job = null
    this.server = null
    this.sweeper = null
    this.disposed = false
  }

  get frontURL() {
    const port = this.server ? this.server.address().port : this.opts.frontPort
    const host = this.opts.bindHost && this.opts.bindHost !== '0.0.0.0' ? this.opts.bindHost : '127.0.0.1'
    return `http://${host}:${port}/v1`
  }

  async start() {
    this.job = createKillJob(this.opts.koffiPath, this.opts.log)
    this.server = http.createServer((req, res) => {
      // 兜底：_route 里任何未捕获的同步异常都不能变成 unhandledRejection 打死宿主
      try {
        this._route(req, res)
      } catch (e) {
        try { res.writeHead(500, { 'content-type': 'application/json' }) } catch { /* 已发头 */ }
        try { res.end(JSON.stringify({ error: { message: String(e && e.message) } })) } catch { /* ignore */ }
      }
    })
    // 关键：不接 'error' 的话，端口被占（EADDRINUSE）会变成未捕获事件，
    // 直接把 DSH 主进程带走。实测过一次，代价是整台 host 退出。
    // 端口被占时不再失败：退回到系统分配的端口继续服务（DSH 自己的 GUI 端口是随机的，
    // 完全可能正好压在配置的端口上）。
    const listen = (port) => new Promise((resolve, reject) => {
      const onError = (e) => {
        this.server?.off('listening', onListening)
        reject(e)
      }
      const onListening = () => {
        this.server?.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(port, this.opts.bindHost || '127.0.0.1')
    })

    try {
      await listen(this.opts.frontPort || 0)
    } catch (e) {
      if (e && e.code === 'EADDRINUSE' && this.opts.frontPort) {
        this.opts.log(`端口 ${this.opts.frontPort} 被占用，改用系统分配的端口`)
        await listen(0)
      } else {
        throw new Error(e && e.code === 'EADDRINUSE'
          ? `端口 ${this.opts.frontPort} 已被占用`
          : String((e && e.message) || e))
      }
    }
    // 运行期再出错也只记录，不再抛出
    this.server.on('error', (e) => this.opts.log(`代理端口错误：${e && e.message}`))
    this.sweeper = setInterval(() => this._sweepIdle(), 1000)
    this.sweeper.unref?.()
    this.opts.log(`front ${this.frontURL}  job=${this.job ? 'on' : 'off'}`)
    return this.frontURL
  }

  status() {
    const out = []
    for (const s of this.slots.values()) {
      out.push({
        id: s.id,
        model: s.model,
        running: !!s.proc,
        ready: s.ready,
        port: s.port,
        pid: s.proc ? s.proc.pid : null,
        busy: s.busy,
        starts: s.starts,
        // 接管来的外部进程：不归我们管，也不会被空闲驱逐
        external: !!s.external
      })
    }
    return { front: this.frontURL, jobObject: !!this.job, slots: out }
  }

  /* ------------------------------------------------------ 生命周期 */

  async ensure(slotId) {
    const s = this.slots.get(slotId)
    if (!s) throw new Error(`unknown slot ${slotId}`)
    if (s.ready) return s
    if (s.starting) return s.starting

    // 已经有人在这台机器上跑着同一个模型（例如 companion-memory 的 organizer）：
    // 直接接管，不再起第二个去抢 NPU；这种进程不归我们管，永不 kill。
    if (s.reusePort) {
      if (await this._probe(s.reusePort)) {
        s.port = s.reusePort
        s.ready = true
        s.external = true
        s.lastUsed = Date.now()
        this.opts.log(`slot ${s.id} 接管已有进程 :${s.reusePort}`)
        return s
      }
    }

    s.starting = this._spawn(s).finally(() => { s.starting = null })
    return s.starting
  }

  async _spawn(s) {
    if (this.disposed) throw new Error('supervisor disposed')
    s.port = await freePort()
    const serveModel = s.serveModel || s.model
    // 启动参数文件 > 槽位自带 args；这里再统一替换占位符
    const rawArgs = (typeof this.opts.argsFor === 'function' && this.opts.argsFor(s))
      || s.args
      || ['serve', '{model}', '--port', '{port}']
    const args = rawArgs.map((a) => String(a)
      .replace('{serveModel}', serveModel)
      .replace('{model}', serveModel)
      .replace('{port}', String(s.port))
      .replace('{ctx}', String(s.contextWindow || 8192)))
    if (s.embed) args.push('--embed', '1')
    const extra = s.extraArgs || []
    args.push(...extra)

    const exe = (typeof this.opts.exeForSlot === 'function' ? this.opts.exeForSlot(s) : '') ||
      s.exePath || this.opts.exePath
    const proc = spawn(exe, args, {
      windowsHide: true,
      stdio: 'ignore',
      // FLM 需要 FLM_MODEL_PATH 才能找到模型目录；其它后端多余变量无害
      env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
      detached: false
    })
    s.proc = proc
    s.ready = false
    s.lastUsed = Date.now()
    s.starts += 1
    if (this.job) this.job.assign(proc.pid)

    let exited = null
    proc.on('error', (e) => {
      exited = -1
      s.proc = null
      s.ready = false
      this.opts.log(`slot ${s.id} spawn error: ${e && e.message}`)
    })
    proc.on('exit', (code) => {
      exited = code
      s.proc = null
      s.ready = false
      this.opts.log(`slot ${s.id} exited code=${code}`)
    })

    const deadline = Date.now() + this.opts.readyTimeoutSec * 1000
    while (Date.now() < deadline) {
      if (exited !== null) {
        throw new Error(
          exited === -1
            ? `启动 ${exe} 失败（找不到可执行文件？请在插件配置里填绝对路径）`
            : `模型进程启动失败（exit ${exited}）`
        )
      }
      if (await this._probe(s.port)) {
        s.ready = true
        s.lastUsed = Date.now()
        this.opts.log(`slot ${s.id} ready :${s.port} pid=${proc.pid}`)
        return s
      }
      await sleep(250)
    }
    this._kill(s)
    throw new Error(`模型 ${s.model} 在 ${this.opts.readyTimeoutSec}s 内没有就绪`)
  }

  async _probe(port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) })
      return r.ok
    } catch { return false }
  }

  _kill(s) {
    if (s.external) return          // 接管来的进程不归我们管
    const proc = s.proc
    s.proc = null
    s.ready = false
    if (!proc || proc.exitCode !== null) return
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        proc.kill('SIGTERM')
      }
    } catch { /* ignore */ }
  }

  _sweepIdle() {
    const now = Date.now()
    for (const s of this.slots.values()) {
      // 只回收「已经就绪、没有请求在飞」的进程。
      // 少了 s.ready 这一条，正在加载的模型会被当成空闲（lastUsed 还是 0）当场杀掉。
      if (!s.proc || !s.ready || s.busy > 0 || s.external) continue
      if (s.idleSec > 0 && now - s.lastUsed > s.idleSec * 1000) {
        this.opts.log(`slot ${s.id} idle ${s.idleSec}s → evict`)
        this._kill(s)
      }
    }
  }

  dispose() {
    this.disposed = true
    if (this.sweeper) clearInterval(this.sweeper)
    for (const s of this.slots.values()) this._kill(s)
    if (this.server) this.server.close()
    if (this.job) { this.job.close(); this.job = null }
  }

  /** 回收所有模型进程（换 exePath 时用），代理本身不关 */
  killAll() {
    for (const s of this.slots.values()) this._kill(s)
  }

  /* ---------------------------------------------------------- 代理 */

  /** 用新的槽位定义热更新：新增/修改的槽位按需起，删掉的立刻回收 */
  updateSlots(defs) {
    const next = new Map()
    for (const s of defs || []) {
      const old = this.slots.get(s.id)
      if (old && old.model === s.model) {
        // 同一个槽、同一个模型：保留进程，只更新参数
        Object.assign(old, {
          name: s.name,
          contextWindow: s.contextWindow,
          think: s.think,
          embed: s.embed,
          alsoServes: s.alsoServes,
          idleSec: s.idleSec ?? old.idleSec,
          args: s.args || old.args,
          llm: s.llm,
          enabled: s.enabled !== false,
          exePath: s.exePath || old.exePath
        })
        next.set(s.id, old)
      } else {
        if (old) this._kill(old)
        next.set(s.id, {
          ...s,
          idleSec: s.idleSec ?? 60,
          proc: null, port: 0, ready: false, starting: null,
          busy: 0, lastUsed: 0, starts: 0
        })
      }
    }
    for (const [id, s] of this.slots) if (!next.has(id)) this._kill(s)
    this.slots = next
  }

  _pickSlot(body) {
    const model = body && typeof body.model === 'string' ? body.model : ''
    // 先按 alsoServes 精确匹配：一个进程可以顺带服务 embedding 模型
    for (const s of this.slots.values()) {
      if (model && (s.alsoServes || []).includes(model)) return s
    }
    for (const s of this.slots.values()) {
      if (model && model === s.model) return s
    }
    // 只允许唯一前缀匹配（例如 FLM 的 qwen3.5:0.8b 与 qwen3.5:0.8b-q4）。
    // 旧实现找不到时静默回第一个槽位，会把 llama3:70b 的请求喂给 llama3:8b。
    if (model) {
      const hits = [...this.slots.values()].filter((s) => model.startsWith(String(s.model).split(':')[0]))
      if (hits.length === 1) return hits[0]
      if (hits.length > 1) return null
      return null
    }
    return this.slots.values().next().value
  }

  _route(req, res) {
    // 只绑 loopback，但浏览器页面是另一个端口，需要放行本机来源的 CORS
    const origin = req.headers.origin || ''
    const lanOpen = (this.opts.bindHost || '127.0.0.1') !== '127.0.0.1'
    const originOk = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin) ||
      (lanOpen && /^https?:\/\/[\w.-]+(:\d+)?$/.test(origin))
    if (originOk) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
      res.setHeader('access-control-allow-headers', 'content-type, authorization')
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // ---- 来源校验：防 DNS rebinding / 跨站盲写 ----
    // 只绑本机时，Host 必须是本机名；跨站 Origin 一律拒绝（浏览器发起的简单请求
    // 会带 Origin，恶意网页没法伪造）。局域网开放时由 token 兜底。
    const hostHeader = String(req.headers.host || '')
    const hostName = hostHeader.replace(/:\d+$/, '')
    const hostOk = lanOpen || /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(hostName)
    if (!hostOk) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'host not allowed' } }))
      return
    }
    if (origin && !originOk) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'origin not allowed' } }))
      return
    }
    // 写操作必须是 JSON：text/plain 的跨站简单请求（CSRF）在这里被挡掉
    const ctype = String(req.headers['content-type'] || '').toLowerCase()
    const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE'
    if (isWrite && ctype && !ctype.startsWith('application/json')) {
      res.writeHead(415, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'content-type must be application/json' } }))
      return
    }

    // 鉴权：先于管理接口执行，否则局域网无 token 也能读写 /npu/config
    //  - 绑到局域网时，非本机来源一律要 Bearer token；没配 token 直接 403 并说明原因，
    //    避免「把 NPU 裸奔到整个局域网」这种事默认发生。
    //  - 本机来源（127.0.0.1 / ::1）不强制，浏览器扩展和本地脚本不用改。
    const remote = (req.socket && (req.socket.remoteAddress || '')) || ''
    const isLocal = /^(::1|127\.|::ffff:127\.)/.test(remote)
    const auth = req.headers.authorization || ''
    const got = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''

    if (!isLocal && !this.opts.apiToken) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: { message: '这个端口对局域网开放，但没设置 apiToken；先在 dsh-npu 设置面板里填一个 token。' }
      }))
      return
    }
    // 本机来源不校验 token：浏览器扩展、本地脚本都不用改配置
    if (!isLocal && this.opts.apiToken && got !== this.opts.apiToken) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unauthorized' } }))
      return
    }

    // 插件自己的管理接口（配置读写、模型清单）：鉴权之后才放行
    if (this.opts.extraRoute && this.opts.extraRoute(req, res)) return
    // extraRoute 没接住才继续走代理；它可能是异步读取 body 的，这里重新挂监听会重复，
    // 所以 /npu/* 之外只处理 /v1/* 与 /npu/status。
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 32 * 1024 * 1024) { req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', async () => {
      let body = null
      if (chunks.length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = null }
      }

      // /npu/status：给运维和别的插件看进程状态，不碰模型
      if (req.url.startsWith('/npu/status')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(this.status()))
        return
      }

      // /v1/models 直接回配置里的模型清单，避免为了列模型把进程拉起来
      if (req.url.startsWith('/v1/models')) {
        const data = [...this.slots.values()]
          .filter((s) => s.enabled !== false)
          .flatMap((s) => [s.model, ...(s.alsoServes || [])])
          .map((id) => ({ id, object: 'model', owned_by: 'local-npu' }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data }))
        return
      }

      // 修 A8：未知路径一律 404，绝不因为一个随机 GET 把模型进程拉起来
      if (!req.url.startsWith('/v1/')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found: ' + req.url } }))
        return
      }

      const slot = this._pickSlot(body)
      if (!slot) { res.writeHead(503).end('no slot'); return }

      try {
        await this.ensure(slot.id)
      } catch (e) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(e.message || e) } }))
        return
      }

      slot.busy += 1
      slot.lastUsed = Date.now()
      const payload = chunks.length ? Buffer.concat(chunks) : null
      // 无论正常结束、客户端中断还是上游报错，busy 只能减一次；
      // 旧实现只在 up 'end' / 'error' 里减，客户端 abort 会让 busy 永久 >0，空闲回收失效。
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        slot.busy = Math.max(0, slot.busy - 1)
        slot.lastUsed = Date.now()
      }

      const upstream = http.request({
        host: '127.0.0.1',
        port: slot.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${slot.port}` },
        timeout: 0
      }, (up) => {
        res.writeHead(up.statusCode || 502, up.headers)
        up.pipe(res)
        up.on('end', done)
        up.on('error', done)
        res.on('close', () => { done(); try { up.destroy() } catch { /* ignore */ } })
      })
      upstream.on('error', (e) => {
        done()
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(e.message || e) } }))
      })
      req.on('aborted', done)
      if (payload) upstream.end(payload)
      else upstream.end()
    })
  }
}





