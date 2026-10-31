/**
 * 验证：Job Object 能不能连带杀死「孙子进程」。
 * 真实场景：Intel NPU 要用 cmd /c "setupvars.bat && ovms.exe ..." 启动，
 * 那时 job 里先进去的是 cmd.exe，真正长跑的服务是它的子进程。
 * 如果 Job 只覆盖直接子进程，KILL_ON_JOB_CLOSE 就会留下孤儿 —— 违反「进程都在 DSH 下面」。
 *
 * 用法：cmd /c ping ... —— ping 是 cmd 的子进程，等价于 ovms 之于 setupvars.bat。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { spawn, execFileSync } from 'node:child_process'
import { createKillJob } from '../lib/supervisor.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function childrenOf(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId`], { encoding: 'utf8' })
    return out.split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number)
  } catch { return [] }
}

test('Job Object 连带杀死孙子进程', async () => {
  const candidates = [
    process.env.DSH_NPU_KOFFI,
    'D:\\DeepSeek\\resources\\app.asar.unpacked\\dsh\\node_modules\\koffi',
  ].filter(Boolean)

  let job = null
  for (const p of candidates) {
    job = createKillJob(p, () => {})
    if (job) break
  }
  if (!job) { console.log('[skip] 找不到 koffi，跳过'); return }

  const cmd = process.env.ComSpec || 'cmd.exe'
  // ping 是 cmd 的子进程，等价于 ovms 之于 setupvars.bat
  const child = spawn(cmd, ['/c', 'ping', '-n', '40', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' })
  job.assign(child.pid)
  await sleep(1200)

  const kids = childrenOf(child.pid)
  const grandchild = kids[0] || 0
  if (!grandchild) {
    job.close(); try { child.kill() } catch { /* ignore */ }
    throw new Error('没找到孙子进程，测试前提不成立')
  }
  assert.ok(alive(grandchild), '孙子进程应该还活着')

  job.close() // 模拟 DSH 退出
  await sleep(1500)

  const gone = !alive(grandchild)
  if (!gone) { try { process.kill(grandchild) } catch { /* 清理 */ } }
  assert.equal(gone, true, `Job 关闭后孙子进程 ${grandchild} 仍存活 —— 会留孤儿`)
})
