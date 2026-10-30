# 横向扩展后端（Intel NPU / 通用 GPU）难度评估

> 结论：**核心架构早就是后端无关的**，缺的是一层「后端描述符」+ 一个「模型从哪来」的答案。
> 难点不在代码量，在**模型格式**和**我没有对应硬件可测**。

调研时间：2026-10。下面每条外部事实都附了来源。

---

## 一、现状：真正绑定 FLM 的只有 5 处

| 位置 | 内容 | 状态 |
|---|---|---|
| `index.js:26` | `exePath: 'flm'` 默认值 | 配置项，可改 |
| `cordis.patch.yml` | `args: ['serve','{model}','--port','{port}','--quiet']` | **每个 slot 可配** |
| `lib/supervisor.mjs:254` | `if (s.embed) args.push('--embed','1')` | ✗ 硬编码 |
| `index.js:404` | `listModels()` 跑 `flm list --filter installed -j` | ✗ 硬编码 |
| `lib/supervisor.mjs:465` | 代理目标 `host: '127.0.0.1'` | ✗ 只能连本机端口 |

**本来就是通用的**：就绪探测（`GET /v1/models`）、按 `model` 路由、`alsoServes` 别名、
OpenAI 协议与 SSE 原样转发、空闲驱逐、Job Object 连带退出，以及
**接管外部进程**（`reusePort` → `external=true` → 永不 kill / 永不驱逐，`supervisor.mjs:312,331`）。

### 已验证：外部服务今天就能接

`test/attach.test.mjs` 起了一个假的 OpenAI 兼容服务，`exePath` 故意填一个不存在的路径：

```
✔ 接管外部 OpenAI 兼容服务：不 spawn、不 kill   (50ms)
```

聊天、`/v1/embeddings`、`alsoServes` 别名路由全部通，`dispose()` 之后外部进程还活着。
**所以 P0 那档的代码基本是现成的，缺的只是面板入口。**

---

## 二、后端对照（2026-10 事实）

| 后端 | Windows 原生 | 就绪探测 | 聊天 + 嵌入同进程 | 模型获取 | NPU |
|---|---|---|---|---|---|
| **FLM**（现状） | ✔ | `/v1/models` | ✔ `--embed 1` | `flm pull` | AMD XDNA2 |
| **llama.cpp** | ✔ 官方预编译 | **`/health` 200/503，最准** | ✗ 单模型；router 模式可 | `-hf` 自动下载 | ✗ |
| **Ollama** | ✔ | ✗ 端口通了 ≠ 模型加载完 | ✔ 天生一个守护进程 | **`/api/pull` 带进度** | ✗ |
| **OVMS**（Intel） | ✔ zip，无需 Docker | `/v1/models`、`/v1/config` | 多 servable，共享同一 NPU 串行 | `--pull --source_model` 直接拉 IR | **Intel NPU/GPU/CPU** |
| **LM Studio** | ✔ 但要装主程序 | `/v1/models` | 同时只加载一个 | `lms get` | ✗ |
| **vLLM** | ✗ 官方明说不支持 | — | — | — | — |

几个会直接影响设计的坑：

1. **llama.cpp 默认端口从 8080 改成了 9931**（v0.7.0），别硬编码。
2. **llama.cpp 的 `--embeddings` 是「只做嵌入」模式**，不能和 chat 共用进程。
   要同端口就得用 router 模式（`--models-dir`，无 `-m`）。
   → 现在 `alsoServes`/`--embed` 那套「一个进程顺带服务嵌入模型」的假设，换后端就破了。
3. **Ollama 的上下文长度没法通过 OpenAI 接口设**，只能 `OLLAMA_CONTEXT_LENGTH`（默认 4096）。
   我们的 `mt` slot 要 1024、`chat` 要 8192，得按后端分别处理。
4. **OVMS 的路径是 `/v3/chat/completions`**，`/v1` 别名 2026.3 才有。

---

## 三、Intel NPU：比预想的窄

官方路线是 **OVMS + `--target_device NPU`**，Windows 11 上 MTL/LNL/ARL 实测支持，
zip 包直接跑，不需要 Docker（`--device /dev/accel` 那套是 Linux 容器才要）。
`--pull --source_model OpenVINO/Qwen3-8B-int4-cw-ov` 能直接从 HF 拉**已经转好的 IR**，
所以「谁来跑 optimum-cli 转换」这个最麻烦的问题，对官方验证过的模型其实不存在。

但有五个硬约束：

| 约束 | 影响 |
|---|---|
| 只支持 **INT4** IR（`--sym --weight-format int4`） | 模型得从 OpenVINO 官方集合里挑 |
| 官方验证列表：Qwen3-8B、Phi-3.5-mini、Phi-3-mini、Mistral-7B、DeepSeek-R1-Distill… | **没有 Llama 3.2，没有 Gemma** |
| Stateful servable：**无批处理、无 prefix caching**（相关参数被忽略） | 多轮对话每轮重算全部历史 |
| 默认窗口 ≈ **1152 token**（`MAX_PROMPT_LEN 1024` + `MIN_RESPONSE_LEN 128`），上限 8K | `chat` slot 的 8192 得改 `--max_length` |
| C++ 版 OVMS **丢弃 system prompt**，流式不返回 usage | 必须用 `_python_on` 包；token 统计要自己算 |

另外两个反直觉的事实：

- **NPU 解码通常比核显/CPU 慢**（社区数据，官方没有 tok/s）。它强在 Whisper 这类固定形状负载，
  以及「不占 GPU、低功耗」。别宣传成"更快"。
- **IPEX-LLM 已于 2026-01-28 被 Intel 归档**，还挂了"known security issues"横幅。
  Intel 显卡走 **llama.cpp Vulkan** 就好，不要碰 IPEX。

---

## 四、方案调整：不依赖外部安装，全部由插件自己拉

原方案里 "P0 接外部 Ollama" 这条路放弃 —— 改成**插件自带运行时**。
前提条件我逐条验证过了：

### 已验证的三个前提

**1. Job Object 能连带杀死孙子进程**（`test/jobtree.test.mjs`）

Intel NPU 要用 `cmd /c "setupvars.bat && ovms.exe ..."` 启动，job 里先进去的是 cmd，
真正长跑的是它的子进程。实测：

```
✔ Job Object 连带杀死孙子进程（cmd → ping 场景，等价于 cmd → ovms）  (3.3s)
```

DSH 一退出，整棵进程树连根拔掉，**不会留孤儿**。这条是"所有进程都在 DSH 下面"的技术保证。

**2. 后端二进制能自动下载**（HTTP 200）

| 来源 | 可达 |
|---|---|
| `api.github.com` llama.cpp releases | ✔ 200 |
| `storage.openvinotoolkit.org` OVMS 包 | ✔ 200 |

**3. 接管外部服务的能力已经在**（`test/attach.test.mjs`，虽然不再是主路线，但保留作为调试手段）

### 真正的"同进程"不可行

llama.cpp / OVMS / FLM 都是独立二进制，没有 Node 绑定能把它们塞进 DSH 主线程。
唯一"同进程"的路子是 onnxruntime-node，但拿不到 Intel NPU 的 EP（Foundry Local 的
Intel OpenVINO EP 是 GPU only），而且性能更差。

**子进程 + Job Object 是等价方案**：进程树挂在 DSH 下面，DSH 退出即全清。
差别只是 `tasklist` 里能多看到一个进程名——用 `--quiet` 和 `windowsHide` 已经尽量低调。

---

## 五、修正后的路线

### P1 · 运行时管理器 + 后端描述符（2~3 天）

插件自己下载、校验、解压、管理各后端的二进制：

```
%LOCALAPPDATA%\dsh-npu\runtimes\        ← 安装根目录（可在面板里改到别的盘）
├─ llamacpp-b7xxx-vulkan\  llama-server.exe + DLL
├─ ovms-2026.4.1\         ovms.exe + setupvars.bat
└─ manifest.json           版本 / sha256 / 解压布局 / 就绪探测
```

配套的后端描述符（现在散在各处的硬编码收进来）：

```js
{
  id, label,
  download: { url, sha256, sizeMB, layout },
  exe: 'llama-server.exe',
  buildArgs(slot),        // FLM: serve {model} --port {port}
                          // llama.cpp: -m {model} --port {port} -c {ctx} -ngl all
  embedArgs(slot),        // FLM: --embed 1 / llama.cpp: 需要独立进程
  env(cfg),               // OVMS: PATH 指向自带 DLL
  readyPath,              // llama.cpp 用 /health 最准
  listModels(cfg)         // FLM: flm list -j；其它: 问上游 /v1/models
}
```

### P2 · llama.cpp profile（2 天）

- Windows 官方预编译：Vulkan x64 约 32 MB，CUDA 版另需 cudart 约 373 MB
- 按显卡厂商选构建：NVIDIA→CUDA、AMD/Intel→Vulkan
- 模型：`-hf user/model` 由子进程自己下载；也可让用户放 gguf 路径
- 嵌入模型要**第二个进程**（`--embeddings` 是"只做嵌入"模式），`alsoServes` 语义要改

### P3 · OVMS profile / Intel NPU（3~5 天 + 真机联调）

- 下载 `ovms_windows_2026.4.1_python_on.zip`（约 133 MB，必须 python_on 版，
  C++ 版会丢弃 system prompt）
- 启动用 `cmd /c "setupvars.bat && ovms.exe --rest_port {port} --config_path {cfg}"`，
  Job Object 已验证能连带清理
- 模型：`ovms.exe --pull --source_model OpenVINO/Qwen3-8B-int4-cw-ov`
  直接从 HF 拉已转好的 INT4 IR，**不需要本地 optimum-cli**
- 要处理：`/v3/chat/completions` 路径、1024+128 的默认窗口、无 prefix caching、
  流式不返回 usage、NPU 上并发是串行的

---

## 五之二、真机实测（2026-10-25，本机）

硬件：AMD Radeon 8060S（核显）+ AMD XDNA2 NPU，C: 剩 14.4 GB / D: 剩 21 GB。

### 运行时下载

| 包 | 体积 | 耗时 | 结果 |
|---|---|---|---|
| llama.cpp Vulkan | 35.3 MB | 22 s（插件内下载） | ✔ sha256 校验通过，解压可用 |
| llama.cpp ROCm | 252 MB | 230 s | ✔ 下来了，但**没有可用设备** |

### 后端实际表现

| 后端 | `--list-devices` | 服务 | 真实加速 |
|---|---|---|---|
| llama.cpp Vulkan | `Vulkan0: AMD Radeon 8060S (16459 MiB)` | ✔ 1.6 s 就绪 | ✔ 真 GPU |
| llama.cpp ROCm | `(none)` | ✔ 能启动、能回答 | **✗ 悄悄跑在 CPU 上** |
| FLM（已有 NPU 实例） | — | ✔ | ✔ NPU |

**这是本次最重要的发现**：ROCm 构建在没有 ROCm 设备的机器上不会报错，
它会静默降级到 CPU，`/health` 照样 200。只看健康探测会把 252 MB 白下、还拿不到加速。
所以选型必须**先跑 `--list-devices`**，设备列表为空就跳过（`lib/select.mjs` 已实现并有测试）。

### 回退链实测

```
探测 → 1. FLM（跳过：本机已装，非内置）→ 2. ROCm（跳过：无可用设备）→ 3. Vulkan ✔
[1.7s] ✓ 选中 llama.cpp · Vulkan，设备 Vulkan0 AMD Radeon 8060S
[3.3s] 服务就绪
[3.4s] 首字 44 ms，总耗时 262 ms
```

### 翻译质量对照（同一句话）

原文：`Uploaded: 13 hours, 14 minutes ago (2026-10-24 00:40:33). Please try again in 30 seconds.`

| 模型 | 译文 | 日期 | 30 秒 | 13 小时 |
|---|---|---|---|---|
| FLM `hy-mt2-flash:1.8b`（1631 ms） | 上传时间：14小时14分钟前（2026-10-24 00:40:33）。请30秒后再次尝试。 | ✔ | ✔ | ✗（13→14） |
| llama.cpp `Qwen2.5-1.5B-Q4_K_M`（262 ms） | 上传：2026-10-24 00:40:33（2小时前14分钟）。请30秒后重试。 | ✔ | ✔ | ✗（13→2） |

两个小模型都算不对相对时间；hy-mt2 更接近（14 vs 13），Qwen2.5-1.5B 差得远。
**结论：通用小模型不能替代专职翻译模型**，hy-mt2 继续做翻译主力，
llama.cpp 这条线适合"通用问答/整理"和"没有 NPU 的机器"。

### 模型下载的坑

`-hf`（llama.cpp 内置下载）在**国内连不上 huggingface.co**（超时）。
`hf-mirror.com` 通（HTTP 200）。所以模型供给必须由插件自己走镜像下载，
再把本地路径用 `-m` 传给 llama-server，不能依赖 `-hf`。

## 五之三、最终决定（2026-10-25）

三条约束定下来了，代码已按这个改：

### 1. CUDA 不进插件，改外挂

CUDA 包 260 MB + cudart 373 MB，为了少数机器把插件撑到 600 MB+ 不划算。

- `RUNTIMES['llamacpp-cuda']` 标成 `external: true`，`sizeMB: 0`，**不下载**
- 用户有 N 卡就自己下一个 CUDA 版，解压到 `<数据根>/extras/llamacpp-cuda/`
- 插件探测到就用，探测不到就跳过并提示放哪（`select.mjs` 已有测试）
- 策略链里 CUDA 仍在（NVIDIA 机器上排在 Vulkan 前面），只是"要不要用"取决于用户放没放

插件自带体积：Vulkan 35 MB + ROCm 252 MB + CPU 23 MB ≈ **310 MB**（可只装需要的）。

### 2. 模型不预装，用户放进 mods

```
<数据根>/mods/*.gguf
```

- `lib/mods.mjs` 扫描（支持子目录、跳过 `mmproj-*` 视觉投影文件）
- 从文件名解析量化（Q4_K_M / Q8_0 / IQ4_XS…）、参数量（1.5B / 7B）、家族（qwen/gemma…）
- 面板按文件名列表让用户选，`findModel()` 支持精确/去扩展名/模糊三种匹配

### 3. 下载只走镜像

`lib/mirrors.mjs`：

| 源 | 地址 |
|---|---|
| hf-mirror | `https://hf-mirror.com/<owner>/<repo>/resolve/main/<file>` |
| 魔搭 ModelScope | `https://modelscope.cn/models/<owner>/<repo>/resolve/master/<file>` |

- `isDirectHuggingFace()` 用于拒绝直连
- `normalizeSource()` 把用户粘进来的 HF 直链自动改写成镜像
- 有测试断言「镜像常量里不含 huggingface.co」

实测：`huggingface.co` 超时，`hf-mirror.com` HTTP 200。

## 六、现实约束（先摆出来）

| 项 | 现状 |
|---|---|
| 磁盘 | C: 剩 **14.4 GB**，D: 剩 21 GB。模型缓存已占 7.8 GB |
| 后端包体积 | llama.cpp Vulkan ~32 MB；CUDA +373 MB；OVMS ~133 MB |
| 模型体积 | GGUF 1~2 GB / 3B；OVMS INT4 8B 约 4.5~5.5 GB；FLM 已装 3 个 |
| 网络 | GitHub 与 OpenVINO 存储都可达，但下载 100MB+ 需要时间，要支持断点/失败重试 |

→ 安装根目录**必须可配置**，默认别放 C:。

---

## 七、建议路线

| 阶段 | 内容 | 覆盖 | 风险 |
|---|---|---|---|
| **P1** | 运行时管理器 + 后端描述符 | 基础设施 | 中（下载/校验/解压要写扎实） |
| **P2** | llama.cpp profile | NVIDIA / AMD / Intel 的 GPU | 中 |
| **P3** | OVMS profile | Intel NPU | 高（要真机） |

外部端点（`reusePort`）保留，但只作为**调试和应急**入口，不是产品路线。

## 八、来源

- llama.cpp：[server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)、[releases](https://github.com/ggml-org/llama.cpp/releases)、[v0.7.0 默认端口 9931](https://github.com/ggml-org/llama.cpp/releases/tag/v0.7.0)
- Ollama：[OpenAI 兼容](https://docs.ollama.com/api/openai-compatibility)、[GPU 支持](https://docs.ollama.com/gpu)、[pull API](https://docs.ollama.com/api/pull)
- OVMS：[NPU LLM 部署](https://docs.openvino.ai/2026/model-server/ovms_demos_llm_npu.html)、[2026.3 `/v1` 别名](https://github.com/openvinotoolkit/model_server/releases/tag/v2026.3)、[2026.4.0 `--max_length`](https://github.com/openvinotoolkit/model_server/releases/tag/v2026.4.0)
- Intel NPU 模型集合：[OpenVINO/llms-optimized-for-npu](https://huggingface.co/collections/OpenVINO/llms-optimized-for-npu)
- IPEX-LLM 归档：[intel/ipex-llm](https://github.com/intel/ipex-llm)
- vLLM Windows：[issue #14981](https://github.com/vllm-project/vllm/issues/14981)
