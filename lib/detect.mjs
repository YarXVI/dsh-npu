/**
 * 硬件探测：这台机器上有什么 NPU、什么显卡、谁的。
 *
 * 只用 Windows 自带的能力（CIM / PnP），不加依赖：
 *   - Win32_VideoController 拿显卡（注意 AdapterRAM 是 uint32，核显会显示 512MB，不可信）
 *   - Win32_PnPEntity / Get-PnpDevice 拿 NPU（Win11 把它归到 ComputeAccelerator 类）
 *
 * 目标是给后端选型提供依据，不追求完备：认不出厂商就当没有，交给回退链。
 */
import { execFile } from 'node:child_process'

/** PCI 厂商号 → 归一化厂商名 */
const VENDOR_BY_PCI = {
  '10de': 'nvidia',
  '1002': 'amd',
  '1022': 'amd',   // AMD 的 NPU / 芯片组也走这个
  '8086': 'intel',
  '5143': 'qualcomm',
}

/** 虚拟显示器、远控、模拟器一律不算显卡 */
const VIRTUAL_RE = /virtual|basic display|remote|parsec|sunshine|spacedesk|mumu|displaylink|idd|mirror/i

export function vendorFromPnp(pnp) {
  const m = /VEN_([0-9A-F]{4})/i.exec(String(pnp || ''))
  return m ? (VENDOR_BY_PCI[m[1].toLowerCase()] || '') : ''
}

export function vendorFromName(name) {
  const n = String(name || '').toLowerCase()
  if (/nvidia|geforce|rtx|quadro|tesla/.test(n)) return 'nvidia'
  if (/\bamd\b|radeon|firepro|instinct/.test(n)) return 'amd'
  if (/intel|\barc\b|iris|uhd graphics|hd graphics/.test(n)) return 'intel'
  if (/qualcomm|adreno|snapdragon/.test(n)) return 'qualcomm'
  return ''
}

/** 名字和 PNP 号两个来源交叉判断，PNP 优先（改名骗不过它） */
export function detectVendor(name, pnp) {
  return vendorFromPnp(pnp) || vendorFromName(name)
}

export function isVirtualDisplay(name, pnp) {
  const p = String(pnp || '')
  if (/^ROOT\\/i.test(p)) return true          // MuMu 这类根设备
  if (/^SWD\\/i.test(p)) return true           // 软件显示适配器
  return VIRTUAL_RE.test(String(name || ''))
}

function psJson(script, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(null)
        try { resolve(JSON.parse(String(stdout || '').trim() || 'null')) } catch { resolve(null) }
      })
  })
}

/** 把 CIM 的单对象/数组统一成数组 */
function asArray(v) {
  if (!v) return []
  return Array.isArray(v) ? v : [v]
}

/**
 * 探测本机硬件。
 * @returns {Promise<{gpus: Array, npus: Array, available: boolean}>}
 */
export async function detectHardware(opts = {}) {
  const ps = opts.psJson || psJson

  // 一次 PowerShell 里把两边都问完，少起一个进程
  const script = `
    $gpus = Get-CimInstance Win32_VideoController |
      Select-Object Name, PNPDeviceID, DriverVersion, AdapterRAM
    $npus = @()
    try {
      $npus = Get-PnpDevice -Class ComputeAccelerator -ErrorAction Stop |
        Where-Object { $_.Status -eq 'OK' } |
        Select-Object FriendlyName, InstanceId, Status
    } catch {
      $npus = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'NPU|Neural|AI Boost|Compute Accelerator|XDNA' } |
        Select-Object Name, PNPDeviceID
    }
    [pscustomobject]@{
      gpus = @($gpus)
      npus = @($npus)
    } | ConvertTo-Json -Depth 4 -Compress
  `

  const raw = await ps(script)
  const gpus = asArray(raw && raw.gpus)
    .map((g) => {
      const name = g.Name || ''
      const pnp = g.PNPDeviceID || ''
      return {
        name,
        vendor: detectVendor(name, pnp),
        pnp,
        driver: g.DriverVersion || '',
        virtual: isVirtualDisplay(name, pnp),
        vramMB: Number(g.AdapterRAM) > 0 ? Math.round(Number(g.AdapterRAM) / 1048576) : 0,
      }
    })
    .filter((g) => g.name)

  const npus = asArray(raw && raw.npus)
    .map((n) => {
      const name = n.FriendlyName || n.Name || ''
      const pnp = n.InstanceId || n.PNPDeviceID || ''
      return {
        name,
        vendor: detectVendor(name, pnp),
        pnp,
        status: n.Status || '',
      }
    })
    .filter((n) => n.name)

  return { gpus, npus, available: !!raw }
}

/** 挑主显卡：独显优先，其次按 NVIDIA > AMD > Intel，虚拟设备不算 */
export function primaryGpu(gpus) {
  const real = (gpus || []).filter((g) => g && !g.virtual && g.vendor)
  const rank = { nvidia: 0, amd: 1, intel: 2, qualcomm: 3 }
  real.sort((a, b) => (rank[a.vendor] ?? 9) - (rank[b.vendor] ?? 9))
  return real[0] || null
}
