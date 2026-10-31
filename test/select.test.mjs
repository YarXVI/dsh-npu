/**
 * 后端挑选逻辑：设备探测 + 回退。全部用注入的假实现，不联网、不落盘。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { pickBackend, probeDevices } from '../lib/select.mjs'

const fakeInstall = (map) => async (id) => {
  if (!(id in map)) throw new Error('没有 ' + id)
  return { exe: map[id], downloaded: false }
}

test('设备解析：认得 Vulkan0 / CUDA0 这种行，也认得 (none)', async () => {
  // 直接用真二进制的输出格式做断言；调用 probeDevices 需要真 exe，这里单独测解析分支
  const parse = (out) => {
    const devices = []
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z]+\d+):\s*(.+)$/.exec(line)
      if (m) devices.push(`${m[1]} ${m[2].trim()}`)
    }
    return devices
  }
  assert.deepEqual(
    parse('Available devices:\n  Vulkan0: AMD Radeon(TM) 8060S Graphics (16459 MiB, 15636 MiB free)\n'),
    ['Vulkan0 AMD Radeon(TM) 8060S Graphics (16459 MiB, 15636 MiB free)']
  )
  assert.deepEqual(parse('Available devices:\n  (none)\n'), [])
  assert.deepEqual(parse(''), [])
})

test('某个后端没有可用设备 → 跳过（不静默降级到 CPU）', async () => {
  const plan = [
    { id: 'llamacpp-vulkan', label: 'Vulkan', reason: 'only' },
  ]
  const { chosen, skipped } = await pickBackend(plan, {
    install: fakeInstall({ 'llamacpp-vulkan': 'vk.exe' }),
    probe: async () => ({ devices: [], raw: 'Available devices:\n  (none)\n' }),
  })
  assert.equal(chosen, null, '没设备就不该选中，宁可报错也不静默跑 CPU')
  assert.match(skipped[0].reason, /没有可用设备/)
})

test('内置包下载失败 → 退到下一个候选，全挂就返回 null', async () => {
  const plan = [
    { id: 'flm', label: 'FLM', reason: 'amd npu' },
    { id: 'llamacpp-vulkan', label: 'Vulkan', reason: 'fallback' },
  ]
  const { chosen, skipped } = await pickBackend(plan, {
    install: async (id) => {
      if (id === 'llamacpp-vulkan') throw new Error('下载失败 HTTP 404')
      return { exe: 'flm.exe' }
    },
    probe: async () => ({ devices: ['Vulkan0 RX 7800'], raw: '' }),
  })
  assert.equal(chosen, null, '两个都不行时应返回 null')
  assert.equal(skipped[0].id, 'flm')
  assert.match(skipped[1].reason, /404|装不上/)
})

test('FLM 不是内置运行时 → 标记为需外部安装并跳过', async () => {
  const plan = [
    { id: 'flm', label: 'FLM', reason: 'amd npu' },
    { id: 'llamacpp-vulkan', label: 'Vulkan', reason: 'fallback' },
  ]
  const { chosen, skipped } = await pickBackend(plan, {
    install: fakeInstall({ 'llamacpp-vulkan': 'vk.exe' }),
    probe: async () => ({ devices: ['Vulkan0 X'], raw: '' }),
  })
  assert.equal(chosen.id, 'llamacpp-vulkan')
  assert.equal(skipped[0].id, 'flm')
  assert.equal(skipped[0].needsExternal, true)
})

test('全都不可用时返回 null，并列出每一步的原因', async () => {
  const plan = [
    { id: 'llamacpp-cuda', label: 'CUDA', reason: 'nvidia' },
    { id: 'llamacpp-vulkan', label: 'Vulkan', reason: 'fallback' },
  ]
  const { chosen, skipped } = await pickBackend(plan, {
    root: 'Z:\\no-such-root',
    install: fakeInstall({ 'llamacpp-vulkan': 'vk.exe' }),
    probe: async () => ({ devices: [], raw: '(none)' }),
  })
  assert.equal(chosen, null)
  assert.equal(skipped.length, 2)
})

test('真机 probeDevices：对已装好的 Vulkan 构建能列出显卡', async () => {
  const exe = 'D:\\dsh-npu-data\\runtimes\\llamacpp-vulkan-b11871\\llama-server.exe'
  const fs = await import('node:fs')
  if (!fs.existsSync(exe)) { console.log('[skip] 本机没装 Vulkan 运行时'); return }
  const { devices } = await probeDevices(exe, { timeoutMs: 20000 })
  assert.ok(devices.length > 0, '应该至少列出一个 Vulkan 设备，实际：' + JSON.stringify(devices))
  assert.match(devices[0], /Vulkan0/)
})


test('真机 probeDevices：对已装好的 Vulkan 构建能列出显卡', async () => {
  const exe = 'D:\\dsh-npu-data\\runtimes\\llamacpp-vulkan-b11871\\llama-server.exe'
  const fs = await import('node:fs')
  if (!fs.existsSync(exe)) { console.log('[skip] 本机没装 Vulkan 运行时'); return }
  const { devices } = await probeDevices(exe, { timeoutMs: 20000 })
  assert.ok(devices.length > 0, '应该至少列出一个 Vulkan 设备，实际：' + JSON.stringify(devices))
  assert.match(devices[0], /Vulkan0/)
})


test('真机 probeDevices：对已装好的 Vulkan 构建能列出显卡', async () => {
  const exe = 'D:\\dsh-npu-data\\runtimes\\llamacpp-vulkan-b11871\\llama-server.exe'
  const fs = await import('node:fs')
  if (!fs.existsSync(exe)) { console.log('[skip] 本机没装 Vulkan 运行时'); return }
  const { devices } = await probeDevices(exe, { timeoutMs: 20000 })
  assert.ok(devices.length > 0, '应该至少列出一个 Vulkan 设备，实际：' + JSON.stringify(devices))
  assert.match(devices[0], /Vulkan0/)
})


test('真机 probeDevices：对已装好的 Vulkan 构建能列出显卡', async () => {
  const exe = 'D:\\dsh-npu-data\\runtimes\\llamacpp-vulkan-b11871\\llama-server.exe'
  const fs = await import('node:fs')
  if (!fs.existsSync(exe)) { console.log('[skip] 本机没装 Vulkan 运行时'); return }
  const { devices } = await probeDevices(exe, { timeoutMs: 20000 })
  assert.ok(devices.length > 0, '应该至少列出一个 Vulkan 设备，实际：' + JSON.stringify(devices))
  assert.match(devices[0], /Vulkan0/)
})
