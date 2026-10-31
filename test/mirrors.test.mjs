/**
 * 下载源：只用镜像，直连 huggingface 一律不用（实测国内超时）。
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { mirrorUrls, isDirectHuggingFace, normalizeSource, MIRRORS } from '../lib/mirrors.mjs'

test('镜像地址：hf-mirror 和魔搭各一条，都不指向 huggingface.co', () => {
  const urls = mirrorUrls('bartowski/Qwen2.5-1.5B-Instruct-GGUF', 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf')
  assert.equal(urls.length, 2)
  for (const u of urls) {
    assert.equal(isDirectHuggingFace(u.url), false, '不能直连 HF：' + u.url)
  }
  assert.match(urls[0].url, /^https:\/\/hf-mirror\.com\/bartowski\//)
  assert.match(urls[1].url, /^https:\/\/modelscope\.cn\/models\/bartowski\//)
  assert.ok(urls[0].url.endsWith('Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'))
})

test('识别并改写直连 HF 地址', () => {
  const direct = 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/x.gguf'
  assert.equal(isDirectHuggingFace(direct), true)
  const { url, rewritten } = normalizeSource(direct)
  assert.equal(rewritten, true)
  assert.match(url, /^https:\/\/hf-mirror\.com\//)
  assert.equal(isDirectHuggingFace(url), false)
})

test('已经是镜像的地址原样保留', () => {
  const mirror = 'https://hf-mirror.com/a/b/resolve/main/c.gguf'
  const { url, rewritten } = normalizeSource(mirror)
  assert.equal(rewritten, false)
  assert.equal(url, mirror)

  const ms = 'https://modelscope.cn/models/a/b/resolve/master/c.gguf'
  assert.equal(normalizeSource(ms).rewritten, false)
})

test('repo 写错时抛错', () => {
  assert.throws(() => mirrorUrls('noslash', 'x.gguf'), /owner\/name/)
  assert.throws(() => mirrorUrls('', 'x.gguf'), /owner\/name/)
})

test('镜像常量没有指向 huggingface', () => {
  for (const v of Object.values(MIRRORS)) assert.equal(isDirectHuggingFace(v), false)
})
