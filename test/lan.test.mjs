import { test } from 'node:test'
import assert from 'node:assert'
import os from 'node:os'
import { NpuSupervisor } from '../lib/supervisor.mjs'

/** 取一个本机局域网 IPv4，没有就跳过 */
function lanIP() {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets || {})) {
    for (const ni of nets[name] || []) {
      const v4 = ni.family === 'IPv4' || ni.family === 4
      if (v4 && !ni.internal && !ni.address.startsWith('169.254.')) return ni.address
    }
  }
  return ''
}

const LAN = lanIP()

test('绑定 0.0.0.0：本机免 token，局域网来源没 token 直接 403', { skip: !LAN && '没有局域网地址' }, async () => {
  const sup = new NpuSupervisor({
    exePath: process.execPath, frontPort: 0, bindHost: '0.0.0.0',
    slots: [], readyTimeoutSec: 5, apiToken: ''
  })
  const front = await sup.start()
  const port = Number(new URL(front).port)
  try {
    const local = await fetch(`http://127.0.0.1:${port}/v1/models`)
    assert.equal(local.status, 200, '本机来源应该直接放行')

    const remote = await fetch(`http://${LAN}:${port}/v1/models`)
    assert.equal(remote.status, 403, '局域网来源没 token 应被拒绝')
    const body = await remote.json()
    assert.match(body.error.message, /apiToken/)
  } finally { sup.dispose() }
})

test('绑定 0.0.0.0 + token：局域网带对 token 才放行，本机依旧免 token', { skip: !LAN && '没有局域网地址' }, async () => {
  const sup = new NpuSupervisor({
    exePath: process.execPath, frontPort: 0, bindHost: '0.0.0.0',
    slots: [], readyTimeoutSec: 5, apiToken: 'secret-lan'
  })
  const front = await sup.start()
  const port = Number(new URL(front).port)
  try {
    const noToken = await fetch(`http://${LAN}:${port}/v1/models`)
    assert.equal(noToken.status, 401)

    const withToken = await fetch(`http://${LAN}:${port}/v1/models`, {
      headers: { authorization: 'Bearer secret-lan' }
    })
    assert.equal(withToken.status, 200)

    const local = await fetch(`http://127.0.0.1:${port}/v1/models`)
    assert.equal(local.status, 200, '本机来源不该被 token 拦住')
  } finally { sup.dispose() }
})

test('绑定 127.0.0.1 时局域网访问不通', { skip: !LAN && '没有局域网地址' }, async () => {
  const sup = new NpuSupervisor({
    exePath: process.execPath, frontPort: 0, bindHost: '127.0.0.1',
    slots: [], readyTimeoutSec: 5
  })
  const front = await sup.start()
  const port = Number(new URL(front).port)
  try {
    await assert.rejects(
      () => fetch(`http://${LAN}:${port}/v1/models`, { signal: AbortSignal.timeout(2500) }),
      '只绑回环时，局域网地址不该连得上'
    )
  } finally { sup.dispose() }
})
