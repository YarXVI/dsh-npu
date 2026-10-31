/** 启动参数文件：默认生成 / 占位符 / 坏 JSON 回退 / 框架归属 / 恢复默认 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  startupArgsFile, ensureStartupArgsFile, readStartupArgs, substituteArgs,
  frameworkOfSlot, argsForSlot, resetStartupArgsFile, DEFAULT_STARTUP_ARGS,
} from '../lib/startup-args.mjs'

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npu-args-'))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('文件不存在时生成带说明的默认文件', () => {
  const t = tmpRoot()
  try {
    const file = ensureStartupArgsFile(t.dir)
    assert.equal(file, startupArgsFile(t.dir))
    assert.ok(fs.existsSync(file))
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.ok(j._readme)
    assert.deepEqual(j.flm.args, DEFAULT_STARTUP_ARGS.flm.args)
    assert.ok(j.llamacpp.args.includes('{ctx}'))
  } finally { t.cleanup() }
})

test('占位符替换：model / serveModel / port / ctx', () => {
  assert.deepEqual(substituteArgs(['serve', '{model}', '--port', '{port}', '--ctx-len', '{ctx}'], {
    model: 'qwen3.5:0.8b', port: 51234, ctx: 8192,
  }), ['serve', 'qwen3.5:0.8b', '--port', '51234', '--ctx-len', '8192'])
  assert.deepEqual(substituteArgs(['{serveModel}'], { model: 'a', serveModel: 'b' }), ['b'])
})

test('坏 JSON 整体回退默认并报错，不会抛异常', () => {
  const t = tmpRoot()
  try {
    const file = startupArgsFile(t.dir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json')
    const loaded = readStartupArgs(t.dir)
    assert.equal(loaded.errors.length, 1)
    assert.deepEqual(loaded.entries.flm.args, DEFAULT_STARTUP_ARGS.flm.args)
  } finally { t.cleanup() }
})

test('自定义 args 生效；args 不是字符串数组时该框架回退默认', () => {
  const t = tmpRoot()
  try {
    const file = startupArgsFile(t.dir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      flm: { args: ['serve', '{model}', '--port', '{port}', '--quiet', '--pmode', 'turbo'] },
      llamacpp: { args: 'oops' },
    }))
    const loaded = readStartupArgs(t.dir)
    assert.ok(loaded.entries.flm.args.includes('turbo'))
    assert.deepEqual(loaded.entries.llamacpp.args, DEFAULT_STARTUP_ARGS.llamacpp.args)
    assert.equal(loaded.errors.length, 1)
  } finally { t.cleanup() }
})

test('框架归属：有 -m 参数的是 llama.cpp，其余是 FLM', () => {
  assert.equal(frameworkOfSlot({ args: ['-m', '{model}', '--port', '{port}'] }), 'llamacpp')
  assert.equal(frameworkOfSlot({ args: ['serve', '{model}', '--port', '{port}'] }), 'flm')
  assert.equal(frameworkOfSlot({ framework: 'llamacpp', args: [] }), 'llamacpp')
})

test('argsForSlot：文件模板 > 槽位 args，并完成占位符替换', () => {
  const t = tmpRoot()
  try {
    ensureStartupArgsFile(t.dir)
    const loaded = readStartupArgs(t.dir)
    const slot = { model: 'qwen3.5:0.8b', port: 50001, contextWindow: 4096, args: ['serve', '{model}'] }
    const args = argsForSlot(slot, loaded)
    assert.deepEqual(args, ['serve', 'qwen3.5:0.8b', '--port', '50001', '--quiet'])
  } finally { t.cleanup() }
})

test('恢复默认：改坏后 reset 能回到默认内容', () => {
  const t = tmpRoot()
  try {
    ensureStartupArgsFile(t.dir)
    const file = startupArgsFile(t.dir)
    fs.writeFileSync(file, JSON.stringify({ flm: { args: ['x'] } }))
    resetStartupArgsFile(t.dir)
    const loaded = readStartupArgs(t.dir)
    assert.deepEqual(loaded.entries.flm.args, DEFAULT_STARTUP_ARGS.flm.args)
    assert.equal(loaded.errors.length, 0)
  } finally { t.cleanup() }
})
