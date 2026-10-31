/**
 * mods 目录：插件不预装模型，只扫描用户自己放进去的 GGUF。
 * 用临时目录造几个假文件，验证解析和挑选逻辑。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { scanMods, findModel, parseQuant, parseParams, parseFamily, ensureModsDir } from '../lib/mods.mjs'

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-'))
  return d
}

test('文件名解析：量化 / 参数量 / 家族', () => {
  assert.equal(parseQuant('Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'), 'Q4_K_M')
  assert.equal(parseQuant('llama-3.2-3b-instruct-q8_0.gguf'), 'Q8_0')
  assert.equal(parseQuant('phi-3-mini-4k-instruct-IQ4_XS.gguf'), 'IQ4_XS')
  assert.equal(parseQuant('model.gguf'), '')

  assert.equal(parseParams('Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'), '1.5B')
  assert.equal(parseParams('Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf'), '8B')
  assert.equal(parseParams('embedding-gemma-300m.gguf'), '')

  assert.equal(parseFamily('Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'), 'qwen')
  assert.equal(parseFamily('gemma-3-1b-it-Q4_K_M.gguf'), 'gemma')
})

test('扫描 mods：只认 .gguf，跳过 mmproj，支持子目录', () => {
  const root = tmpdir()
  try {
    const mods = ensureModsDir(root)
    fs.writeFileSync(path.join(mods, 'a-Q4_K_M.gguf'), Buffer.alloc(2048))
    fs.writeFileSync(path.join(mods, 'readme.txt'), 'not a model')
    fs.writeFileSync(path.join(mods, 'mmproj-vision.gguf'), Buffer.alloc(64))  // 视觉投影，不是主模型
    fs.mkdirSync(path.join(mods, 'qwen'), { recursive: true })
    fs.writeFileSync(path.join(mods, 'qwen', 'b-Q8_0.gguf'), Buffer.alloc(4096))

    const list = scanMods(mods)
    assert.equal(list.length, 2, '应该只认出 2 个真模型，实际：' + list.map((m) => m.file).join(','))
    assert.deepEqual(list.map((m) => m.file), ['a-Q4_K_M.gguf', 'b-Q8_0.gguf'])
    const b = list.find((m) => m.file === 'b-Q8_0.gguf')
    assert.equal(b.quant, 'Q8_0')
    assert.ok(b.path.includes('qwen'), '子目录里的模型要能扫到')
    assert.ok(b.sizeMB >= 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('目录不存在时返回空数组，不抛错', () => {
  assert.deepEqual(scanMods('Z:\\definitely-not-here'), [])
})

test('按名字挑模型：文件名优先，其次模糊匹配', () => {
  const list = [
    { file: 'Qwen2.5-1.5B-Q4_K_M.gguf', name: 'Qwen2.5-1.5B-Q4_K_M' },
    { file: 'gemma-3-1b-Q8_0.gguf', name: 'gemma-3-1b-Q8_0' },
  ]
  assert.equal(findModel(list, 'Qwen2.5-1.5B-Q4_K_M.gguf').file, 'Qwen2.5-1.5B-Q4_K_M.gguf')
  assert.equal(findModel(list, 'Qwen2.5-1.5B-Q4_K_M').file, 'Qwen2.5-1.5B-Q4_K_M.gguf')
  assert.equal(findModel(list, 'gemma').file, 'gemma-3-1b-Q8_0.gguf')
  assert.equal(findModel(list, ''), null)
  assert.equal(findModel(list, 'nope'), null)
})
