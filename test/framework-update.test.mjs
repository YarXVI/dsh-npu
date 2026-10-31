/** 框架更新：版本比较 / 镜像前缀 / 本地构建识别（不联网） */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareVersions, compareBuild, withMirror, installedLlamaBuild, declaredLlamaBuild } from '../lib/framework-update.mjs'

test('FLM 版本比较', () => {
  assert.equal(compareVersions('1.0.11', '1.0.10'), 1)
  assert.equal(compareVersions('1.0.10', '1.0.11'), -1)
  assert.equal(compareVersions('v1.0.10', '1.0.10'), 0)
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1)
})

test('llama.cpp 构建号比较', () => {
  assert.equal(compareBuild('b11981', 'b11871'), 1)
  assert.equal(compareBuild('b11871', 'b11981'), -1)
  assert.equal(compareBuild('b11871', 'b11871'), 0)
  assert.equal(compareBuild('', 'b11871'), -1)
})

test('镜像前缀只拼一次，空值原样返回', () => {
  const u = 'https://github.com/a/b/releases/download/x/y.zip'
  assert.equal(withMirror(u, ''), u)
  assert.equal(withMirror(u, 'https://ghfast.top/'), 'https://ghfast.top/' + u)
  assert.equal(withMirror(u, 'https://ghfast.top'), 'https://ghfast.top/' + u)
})

test('已装 llama.cpp 构建：扫描目录取最大 bXXXXX，没有则用内置版本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npu-llama-'))
  try {
    for (const n of ['llamacpp-vulkan-b11871', 'llamacpp-rocm-b11981', 'not-a-runtime']) {
      fs.mkdirSync(path.join(dir, n), { recursive: true })
    }
    assert.equal(installedLlamaBuild(dir), 'b11981')
    assert.equal(installedLlamaBuild(path.join(dir, 'missing')), declaredLlamaBuild())
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
