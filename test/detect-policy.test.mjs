import { test } from 'node:test'
import assert from 'node:assert'
import { vendorFromName, vendorFromPnp, detectVendor, isVirtualDisplay, primaryGpu } from '../lib/detect.mjs'
import { planBackends, describePlan } from '../lib/policy.mjs'

/* ------------------------------------------------ 厂商识别 */

test('厂商：PNP 号的优先级高于名字', () => {
  assert.equal(vendorFromPnp('PCI\\VEN_10DE&DEV_2684'), 'nvidia')
  assert.equal(vendorFromPnp('PCI\\VEN_1002&DEV_1586'), 'amd')
  assert.equal(vendorFromPnp('PCI\\VEN_8086&DEV_7D55'), 'intel')
  // AMD 的 NPU 也走 VEN_1022
  assert.equal(vendorFromPnp('PCI\\VEN_1022&DEV_17F0'), 'amd')
  // 名字被改成 "AMD Radeon" 的 NVIDIA 卡，PNP 说了算
  assert.equal(detectVendor('AMD Radeon RX 7900', 'PCI\\VEN_10DE&DEV_2684'), 'nvidia')
})

test('厂商：没有 PNP 时靠名字兜底', () => {
  assert.equal(detectVendor('NVIDIA GeForce RTX 4070'), 'nvidia')
  assert.equal(detectVendor('AMD Radeon(TM) 8060S Graphics'), 'amd')
  assert.equal(detectVendor('Intel(R) Arc(TM) B580'), 'intel')
  assert.equal(detectVendor('Intel(R) Iris(R) Xe Graphics'), 'intel')
  assert.equal(detectVendor('Microsoft Basic Display Adapter'), '')
  assert.equal(vendorFromName('Snapdragon X Elite Adreno'), 'qualcomm')
})

test('虚拟显示器不算显卡', () => {
  assert.equal(isVirtualDisplay('MuMu Virtual Display Adapter', 'ROOT\\DISPLAY\\0000'), true)
  assert.equal(isVirtualDisplay('Microsoft Basic Display Adapter', 'PCI\\VEN_1414&DEV_008C'), true)
  assert.equal(isVirtualDisplay('AMD Radeon(TM) 8060S Graphics', 'PCI\\VEN_1002&DEV_1586'), false)
})

test('主显卡：独显优先，虚拟设备排除', () => {
  const hw = [
    { name: 'MuMu Virtual Display Adapter', vendor: '', virtual: true },
    { name: 'Intel UHD Graphics', vendor: 'intel', virtual: false },
    { name: 'NVIDIA GeForce RTX 4070', vendor: 'nvidia', virtual: false },
  ]
  assert.equal(primaryGpu(hw).vendor, 'nvidia')
})

/* ------------------------------------------------ 后端链 */

const plan = (gpus, npus) => planBackends({ gpus, npus })
const ids = (p) => p.map((x) => x.id)

test('FLM 永远排第一（默认框架）', () => {
  const p = plan([{ name: 'NVIDIA RTX 4070', vendor: 'nvidia', virtual: false }], [])
  assert.equal(ids(p)[0], 'flm', '没 NPU 也要先试 FLM')
})

test('AMD NPU + AMD 显卡：FLM → ROCm → Vulkan', () => {
  const p = plan(
    [{ name: 'AMD Radeon 8060S', vendor: 'amd', virtual: false }],
    [{ name: 'NPU Compute Accelerator Device', vendor: 'amd', status: 'OK' }]
  )
  assert.deepEqual(ids(p), ['flm', 'llamacpp-rocm', 'llamacpp-vulkan'])
})

test('NVIDIA 显卡：FLM → CUDA → Vulkan', () => {
  const p = plan([{ name: 'NVIDIA GeForce RTX 4070', vendor: 'nvidia', virtual: false }], [])
  assert.deepEqual(ids(p), ['flm', 'llamacpp-cuda', 'llamacpp-vulkan'])
})

test('AMD 显卡无 NPU：FLM → ROCm → Vulkan', () => {
  const p = plan([{ name: 'AMD Radeon RX 7800 XT', vendor: 'amd', virtual: false }], [])
  assert.deepEqual(ids(p), ['flm', 'llamacpp-rocm', 'llamacpp-vulkan'])
})

test('Intel 显卡：FLM → Vulkan（不排 CUDA/ROCm）', () => {
  const p = plan([{ name: 'Intel Arc B580', vendor: 'intel', virtual: false }], [])
  assert.deepEqual(ids(p), ['flm', 'llamacpp-vulkan'])
})

test('没有认出显卡：FLM → Vulkan', () => {
  assert.deepEqual(ids(plan([], [])), ['flm', 'llamacpp-vulkan'])
})

test('虚拟显卡被忽略', () => {
  const p = plan([{ name: 'MuMu Virtual Display Adapter', vendor: '', virtual: true }], [])
  assert.deepEqual(ids(p), ['flm', 'llamacpp-vulkan'])
})

test('后端链可读摘要', () => {
  const p = plan([{ name: 'NVIDIA RTX 4070', vendor: 'nvidia', virtual: false }], [])
  const text = describePlan(p)
  assert.match(text, /^1\. FastFlowLM/)
  assert.match(text, /CUDA.*→.*Vulkan/s)
})

/* ------------------------------------------------ 真机冒烟 */

test('真机：能探测出显卡，且排出的链非空', async () => {
  const { detectHardware } = await import('../lib/detect.mjs')
  const hw = await detectHardware()
  assert.equal(hw.available, true, 'PowerShell 探测应该成功')
  assert.ok(Array.isArray(hw.gpus))
  const p = planBackends(hw)
  assert.ok(p.length >= 1)
  assert.equal(p[p.length - 1].id, 'llamacpp-vulkan', '最后一项必须是 Vulkan 兜底')
  assert.equal(p[0].id, 'flm', '第一项必须是 FLM')
})
