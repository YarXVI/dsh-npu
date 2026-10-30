/**
 * 运行时管理器：本地起一个假下载源，验证「下载 → 校验 → 解压 → 拿到 exe」整条链路。
 * 真下载（GitHub 35MB）留给集成验证，不放进单测。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ensureRuntime, installed, removeRuntime, RUNTIMES, urlOf, LLAMACPP_BUILD } from '../lib/runtimes.mjs'

function makeZip(dir, files) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-src-'))
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(stage, name)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  const zip = path.join(dir, 'pkg.zip')
  execFileSync('tar', ['-a', '-cf', zip, '-C', stage, '.'], { windowsHide: true })
  fs.rmSync(stage, { recursive: true, force: true })
  return zip
}

function serveFile(file) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    const buf = fs.readFileSync(file)
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length })
    res.end(buf)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port }))
  })
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

test('清单：三个 llama.cpp 附加包都可下载，都有直链', () => {
  assert.deepEqual(Object.keys(RUNTIMES).sort(), ['llamacpp-cuda', 'llamacpp-rocm', 'llamacpp-vulkan'])
  for (const [id, r] of Object.entries(RUNTIMES)) {
    assert.equal(r.id, id)
    assert.ok(r.exe, id + ' 缺 exe')
    assert.ok(r.file, id + ' 缺 file')
    assert.ok(r.sizeMB > 0, id + ' 缺体积')
    assert.ok(r.note, id + ' 缺说明文字')
    assert.match(urlOf(id), new RegExp(`/b\\d+/${r.file.replace(/\./g, '\\.')}$`))
  }
  assert.deepEqual(RUNTIMES['llamacpp-vulkan'].needs, [])
  assert.ok(RUNTIMES['llamacpp-cuda'].needs.length > 0, 'CUDA 还要 cudart')
  assert.match(urlOf('llamacpp-vulkan', 'http://mirror.local/x/'), /^http:\/\/mirror\.local\/x\/b\d+\//)
})

test('下载 + 校验 + 解压 + 找到 exe（本地假源）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'))
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'))
  const zip = makeZip(stage, { 'llama-server.exe': 'MZ-fake', 'ggml-vulkan.dll': 'dll' })
  const { server, hits, port } = await serveFile(zip)

  try {
    assert.equal(installed(root, 'llamacpp-vulkan'), null, '还没装时应为 null')

    const { exe, downloaded } = await ensureRuntime('llamacpp-vulkan', {
      root,
      baseUrl: `http://127.0.0.1:${port}`,
      sha256: sha(zip),
    })

    assert.equal(downloaded, true)
    assert.ok(fs.existsSync(exe), 'exe 应该被解压出来')
    assert.ok(exe.includes(`llamacpp-vulkan-${LLAMACPP_BUILD}`), '应落在带版本号的目录里')
    assert.ok(hits.length >= 1, '应该真的发了下载请求')

    // 第二次调用不应再下载
    const again = await ensureRuntime('llamacpp-vulkan', {
      root, baseUrl: `http://127.0.0.1:${port}`, sha256: sha(zip),
    })
    assert.equal(again.downloaded, false, '已装好时不该重复下载')

    await removeRuntime('llamacpp-vulkan', { root })
    assert.equal(installed(root, 'llamacpp-vulkan'), null)
  } finally {
    await new Promise((r) => server.close(r))
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(stage, { recursive: true, force: true })
  }
})

test('sha256 不匹配时抛错，且不留下半截文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt2-'))
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg2-'))
  const zip = makeZip(stage, { 'llama-server.exe': 'MZ-fake' })
  const { server, port } = await serveFile(zip)

  try {
    await assert.rejects(
      () => ensureRuntime('llamacpp-vulkan', {
        root,
        baseUrl: `http://127.0.0.1:${port}`,
        sha256: 'deadbeef'.repeat(8),   // 故意给错的
      }),
      /校验失败/
    )
    assert.equal(installed(root, 'llamacpp-vulkan'), null, '校验失败不该留下可用的 exe')

    const dir = path.join(root, `llamacpp-vulkan-${LLAMACPP_BUILD}`)
    const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.part')) : []
    assert.deepEqual(leftovers, [], '不该留下 .part 半截文件')
  } finally {
    await new Promise((r) => server.close(r))
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(stage, { recursive: true, force: true })
  }
})
