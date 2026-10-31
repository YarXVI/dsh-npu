/**
 * 模型下载源：只走镜像，**直连 huggingface.co 一律不用**（国内基本连不上，实测超时）。
 *
 *   优先 hf-mirror.com（与 HF 接口兼容，路径可直接替换）
 *   其次 ModelScope（阿里魔搭，国内速度快）
 *
 * 插件本身不预装模型；这个模块只给「用户点了下载」这条可选路径用。
 */

export const MIRRORS = {
  hfMirror: 'https://hf-mirror.com',
  modelscope: 'https://modelscope.cn',
}

/** 直连地址——出现在代码里只为识别和拒绝，不允许使用 */
const DIRECT_HF = /^https?:\/\/(www\.)?huggingface\.co\//i

/**
 * 同一个文件在各镜像上的地址。
 * @param {string} repo  形如 bartowski/Qwen2.5-1.5B-Instruct-GGUF
 * @param {string} file  文件名，如 Qwen2.5-1.5B-Instruct-Q4_K_M.gguf
 */
export function mirrorUrls(repo, file) {
  const [owner, name] = String(repo || '').split('/')
  if (!owner || !name) throw new Error('repo 要写成 owner/name 的形式')
  const f = encodeURIComponent(file)
  return [
    {
      id: 'hf-mirror',
      url: `${MIRRORS.hfMirror}/${owner}/${name}/resolve/main/${f}`,
      note: 'HuggingFace 镜像',
    },
    {
      id: 'modelscope',
      url: `${MIRRORS.modelscope}/models/${owner}/${name}/resolve/master/${f}`,
      note: '魔搭 ModelScope',
    },
  ]
}

/** 判断一个地址是不是直连 HF（调用方应该拒掉） */
export function isDirectHuggingFace(url) {
  return DIRECT_HF.test(String(url || ''))
}

/**
 * 用户在面板里粘贴的下载地址：直连 HF 的自动改写成镜像。
 * @returns {{url:string, rewritten:boolean}}
 */
export function normalizeSource(url) {
  const raw = String(url || '').trim()
  if (!raw) return { url: '', rewritten: false }
  if (!isDirectHuggingFace(raw)) return { url: raw, rewritten: false }
  return { url: raw.replace(DIRECT_HF, MIRRORS.hfMirror + '/'), rewritten: true }
}
