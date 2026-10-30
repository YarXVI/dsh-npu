/**
 * 后端选型：根据探测到的硬件，排出一条「先试谁、失败退给谁」的链。
 *
 * 规则（按用户定的优先级）：
 *   1. 有 NPU 且是 AMD  → FLM（NPU 原生） → ROCm → Vulkan
 *   2. 没有可用 NPU，看显卡厂商：
 *        NVIDIA → CUDA → Vulkan
 *        AMD    → ROCm → Vulkan
 *        Intel  → Vulkan
 *   3. 任何一步起不来，就往链子的下一项退；Vulkan 是最后的兜底，CPU 收底
 *
 * 注意：这里只产出「顺序 + 原因」，不判断某个构建是否真能跑。
 * 真跑得起来由 supervisor 实际 spawn + 健康探测确认，失败就落下一项。
 */

export const BACKENDS = {
  flm: {
    id: 'flm',
    label: 'FastFlowLM (AMD NPU)',
    runtime: 'flm',
    hardware: 'npu-amd',
  },
  'llamacpp-cuda': {
    id: 'llamacpp-cuda',
    label: 'llama.cpp · CUDA',
    runtime: 'llamacpp-cuda',
    hardware: 'gpu-nvidia',
  },
  'llamacpp-rocm': {
    id: 'llamacpp-rocm',
    label: 'llama.cpp · ROCm',
    runtime: 'llamacpp-rocm',
    hardware: 'gpu-amd',
  },
  'llamacpp-vulkan': {
    id: 'llamacpp-vulkan',
    label: 'llama.cpp · Vulkan（通用）',
    runtime: 'llamacpp-vulkan',
    hardware: 'gpu-any',
  },
}

/**
 * @param {{gpus: Array, npus: Array}} hw  detectHardware() 的结果
 * @returns {Array<{id: string, label: string, reason: string}>} 有序候选链
 */
export function planBackends(hw) {
  const plan = []
  const push = (id, reason) => {
    const b = BACKENDS[id]
    if (!b) return
    if (plan.some((p) => p.id === id)) return   // 去重
    plan.push({ id, label: b.label, reason })
  }

  const npus = (hw && hw.npus) || []
  const gpus = (hw && hw.gpus) || []

  const npu = npus.find((n) => n.vendor) || null
  const realGpus = gpus.filter((g) => !g.virtual && g.vendor)
  const rank = { nvidia: 0, amd: 1, intel: 2, qualcomm: 3 }
  const gpu = realGpus.slice().sort((a, b) => (rank[a.vendor] ?? 9) - (rank[b.vendor] ?? 9))[0] || null

  // 1) FLM 是默认框架：永远排第一，装了 flm.exe 就用它
  push('flm', '默认框架，优先级最高（需要本机装有 flm.exe）')

  // 2) 按显卡厂商排附加包
  if (gpu && gpu.vendor === 'nvidia') push('llamacpp-cuda', `NVIDIA 显卡：${gpu.name}`)
  else if (gpu && gpu.vendor === 'amd') push('llamacpp-rocm', `AMD 显卡：${gpu.name}`)

  // 3) Vulkan 兜底：前面失败或没装附加包时用它
  push('llamacpp-vulkan', gpu ? '通用兜底，AMD / Intel / NVIDIA 都能跑' : '没认出显卡，先试 Vulkan')

  return plan
}

/** 给面板/日志看的一句话摘要 */
export function describePlan(plan) {
  return plan.map((p, i) => `${i + 1}. ${p.label}（${p.reason}）`).join(' → ')
}
