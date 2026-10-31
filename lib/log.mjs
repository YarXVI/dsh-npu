/**
 * 统一日志：`<dataRoot>/logs/dsh-npu.log`
 *
 *   - 磁盘：环形上限（默认 2 MB），超过后只保留最新的一半，避免长期运行把盘写满；
 *   - 内存：保留最近 200 行，面板 `GET logs` 直接读内存，不用每次扫文件；
 *   - 任何写盘失败都只降级为内存日志，绝不因为日志把插件弄崩。
 *
 * 用法：`const log = createLogger({ dataRoot }); log('msg'); log.warn('msg')`
 */
import fs from 'node:fs'
import path from 'node:path'

export const MAX_BYTES = 2 * 1024 * 1024
export const MAX_LINES = 200

const stamp = (d = new Date()) => d.toISOString()

function safeStatSize(file) {
  try { return fs.statSync(file).size } catch { return 0 }
}

export function createLogger(opts = {}) {
  const dataRoot = String(opts.dataRoot || '').trim()
  const file = opts.file !== undefined
    ? String(opts.file || '')
    : (dataRoot ? path.join(dataRoot, 'logs', 'dsh-npu.log') : '')
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_BYTES
  const maxLines = Number(opts.maxLines) > 0 ? Number(opts.maxLines) : MAX_LINES
  const hostLogger = opts.logger || null   // ctx.logger：DSH 控制台
  const now = typeof opts.now === 'function' ? opts.now : () => new Date()

  const memory = []
  let bytes = file ? safeStatSize(file) : 0
  let broken = false

  function pushMemory(line) {
    memory.push(line)
    while (memory.length > maxLines) memory.shift()
  }

  function rotateIfNeeded() {
    if (!file || bytes <= maxBytes) return
    try {
      // 只保留最新的一半，切在行边界上；写 tmp 再 rename，避免留下半截文件
      const keep = Math.max(1024, Math.floor(maxBytes / 2))
      const text = fs.readFileSync(file, 'utf8')
      const tail = text.slice(Math.max(0, text.length - keep))
      const at = tail.indexOf('\n')
      const body = at >= 0 ? tail.slice(at + 1) : tail
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, file)
      bytes = Buffer.byteLength(body)
    } catch { broken = true }
  }

  function write(level, msg) {
    const line = `${stamp(now())} [${level}] ${msg}`
    pushMemory(line)
    if (hostLogger) {
      try {
        const fn = typeof hostLogger[level] === 'function' ? hostLogger[level]
          : (typeof hostLogger.info === 'function' ? hostLogger.info : null)
        if (fn) fn.call(hostLogger, `[npu] ${msg}`)
      } catch { /* 宿主 logger 不可用 */ }
    }
    if (!file || broken) return line
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, line + '\n')
      bytes += Buffer.byteLength(line) + 1
      rotateIfNeeded()
    } catch {
      broken = true   // 目录只读之类：之后只走内存
    }
    return line
  }

  /** 最近 n 行（默认 200）。内存不够时回读文件尾部。 */
  function lines(n) {
    const want = Math.max(1, Math.min(10000, Number(n) || maxLines))
    if (want <= memory.length) return memory.slice(-want)
    if (!file) return memory.slice(-want)
    try {
      const text = fs.readFileSync(file, 'utf8').trimEnd()
      if (!text) return memory.slice(-want)
      return text.split(/\r?\n/).slice(-want)
    } catch {
      return memory.slice(-want)
    }
  }

  const info = (msg) => { write('info', String(msg)); }
  info.info = info
  info.warn = (msg) => { write('warn', String(msg)); }
  info.error = (msg) => { write('error', String(msg)); }
  info.debug = (msg) => { if (opts.debug) write('debug', String(msg)); }
  info.log = (msg) => info(msg)
  info.lines = lines
  info.file = () => file
  info.size = () => bytes
  info.ring = () => maxBytes
  info.memoryLines = () => memory.length
  info.isBroken = () => broken
  info.close = () => { memory.length = 0 }
  return info
}