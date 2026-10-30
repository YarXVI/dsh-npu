# 第五框架 · amd-hybrid 设计与实测

> 结论先说：AMD 平台上真正能落地的「NPU + GPU 混合推理」，**不是再找一个推理引擎**，而是在已有两代运行时之上做一层**双引擎协同层**。它必须满足三个硬条件：进程归宿主所有（无第三方窗口、无链式启动器）、对上层只有一个 OpenAI 兼容端口、失败时显式降级而不是偷偷换云。
>
> 本机的第五框架 `amd-hybrid` 就是这层协同层：FLM（AMD XDNA2 NPU）+ llama.cpp Vulkan（Radeon 8060S iGPU），同一插件、同一 Windows Job Object、一个端口。实测数据见 §5。

---

## 1. 先看 AMD 生态里「已存在」的混合方案，逐条判本机可用性

| 方案 | 做法 | 本机可用性 | 不采用的原因 |
|---|---|---|---|
| **AMD Ryzen AI Software（1.x）** | 把 ONNX 模型编译成 NPU（VitisAI EP）/ GPU（MIGraphX/DirectML EP）子图，由 ONNX Runtime 自动切分，一个 session 里 NPU 与 GPU 各跑一部分 | ❌ 不可用 | 需要 Ryzen AI 专用 ORT 分支 + 模型量化编译（`ryzen-ai-1.x` 的 `ort` 轮子对 Python 3.14 无包）；且它是**单进程内**切图，模型必须重新编译，对已经跑通的 FLM/llama.cpp 资产零复用 |
| **ONNX Runtime GenAI + VitisAI / RyzenAI EP** | 同上，但走 GenAI 生成接口 | ❌ 不可用 | 本机实测 `onnxruntime-genai 0.18.0` 仅含 CPU / Azure EP，`get_available_providers()` 无 `VitisAIExecutionProvider` / `RyzenAIExecutionProvider`；Python 3.14 装不上 Ryzen AI 轮子 |
| **Lemonade（AMD 官方示例应用）** | 自带 NPU/GPU 选择、模型下载、Web UI | ❌ 不采用 | 是**独立桌面应用**：有自己的窗口、自己的进程管理、自己的端口，正是本任务明确禁止的「第三方窗口 / 链式启动器」 |
| **Amuse（AMD 本地 AI 应用）** | 同上，图形化封装 | ❌ 不采用 | 同上；且闭源安装包，无法随 DSH 生命周期托管 |
| **llama.cpp 的 NPU 后端** | 期望 `-ngl` 直接把层放 NPU | ❌ 不存在 | llama.cpp 至今没有 XDNA/NPU 后端；ROCm 后端在本机 8060S 上会**静默回退 CPU**（`/health` 仍 200，必须用 `--list-devices` 才能发现没上 GPU）——审计报告 A11 记录了这个坑 |
| **vLLM / SGLang** | 服务端批处理框架 | ❌ 不适合 | 面向数据中心 GPU，Windows + 核显无官方路径；同样引入独立服务窗口 |
| **我们：`amd-hybrid` 双引擎协同层** | 复用 FLM(NPU) 与 llama.cpp(GPU) 两个**已就跑通**的引擎，在插件内做路由/竞速/级联/增强 | ✅ 本机可用（实测，见 §5） | 不是新引擎，是协同层；进程全部由 DSH 的 Job Object 托管 |

> 一句话：AMD 官方给的是「把模型编译进 NPU」，我们给的是「把已经能跑的 NPU 引擎与 GPU 引擎**编排**起来」。前者要求重新编译模型、绑定特定 ORT 版本；后者零模型改造、零第三方窗口，代价是两引擎各占一份显存/内存（本机 0.8B + 1.5B Q4，合计 < 2.5 GB）。

## 2. 第五框架的边界（诚实说明）

- **它不是投机解码**：llama.cpp 的投机解码要求草稿模型与目标模型**同一分词器、同一词表**，且 `n_probs` 只能校验采样分布、无法逐 token 验证 prompt 里的既有 token。用 FLM 的 0.8B 去给 llama.cpp 的 1.5B 做草稿，词表都不同，只能叫「启发式前哨」，不能宣称是 speculative decoding。本实现没有把它包装成投机解码。
- **它不是模型切分**：不做「前 N 层 NPU、后 M 层 GPU」的层切分。层切分需要同一引擎支持跨设备 tensor 传输，FLM 与 llama.cpp 是两套运行时，做不到。
- **它不偷偷上云**：任何引擎不可用都返回 503 + 明示原因（面板健康自检同步显示），绝不回退到云端 API。

## 3. 四个模式

| 模式 | 触发/行为 | 适合 | 流式 |
|---|---|---|---|
| `route` | 按请求特征选一个引擎：embedding / 翻译 → NPU；代码 / 长文 → GPU；失败后切另一个引擎（fallback 计入 timings） | 单请求、要确定性 | ✅ |
| `race` | 两引擎同时发非流式请求，先给出**完整答案**者胜，另一个 AbortController 取消；`raceTimeoutMs` 到点只取消 NPU（把预算留给 GPU） | 尾延迟敏感、同一 prompt 只问一次 | ❌ 仅非流式 |
| `cascade` | 先 NPU 拿「首段」；`peekChars` 内出现拒答 / 截断 / 退化（重复、空）→ 取消 NPU、换 GPU 重答；已流出正文则不再升级 | 短问答想省 GPU 占用、又怕小模型翻车 | ✅（升级前不吐字） |
| `augment` | GPU 主答；NPU 并行做预处理：embedding 检索、短文本翻译、上下文摘要，作为提示词增强再交给 GPU | 长上下文、需要检索/翻译增强的问答 | ✅ |

`mode: auto` 由 `classify()` 决定：翻译/embedding 走 NPU、代码/长文走 GPU，默认取 `cascade` 语义（短问先 NPU）。面板里可一键切四模式，并可跑 `hybrid/bench` 现场对比。

### 时序（文字版）

```
route:    用户 → classify → [NPU 或 GPU] → 返回；失败 → 另一引擎 → 返回
race:     用户 → NPU ┐
                    ├─ 先完成者 → 返回（另一个 abort）
                GPU ┘
cascade:  用户 → NPU 首段 → 合格？→ 流式继续 NPU
                        └ 不合格（拒答/截断/退化）→ abort NPU → GPU 整答
augment:  用户 → NPU(embed/translate/summary) ┐
                                            ├→ 拼增强 prompt → GPU → 返回
           GPU 等待 ─────────────────────────┘
```

## 4. 进程归属与「无第三方窗口」

- 两个引擎都由 `NpuSupervisor` 用 `spawn` 起，**创建即加入同一个 Windows Job Object（kill-on-close）**；DSH 主进程退出 / 被杀 → Job 关闭 → `flm.exe` 与 `llama-server.exe` 一起被内核终止，不存在监听进程残留。
- 不调用任何外部 GUI：没有 Lemonade/Amuse 窗口，不弹浏览器，不装服务（无 Windows Service / 自启项）。
- 面板与 OpenAI 端口都在 DSH 内：面板挂 `webServer` 的 `/plugins/dsh-npu/panel`，推理端口是插件自己 `http.createServer` 的 loopback 端口；外部只见一个端口。
- 验证方法：`bench.mjs` 里 `sup.dispose()` 后 `tasklist | findstr flm.exe llama-server.exe` 为空（实测 §5.3）；`test/jobtree.test.mjs` 覆盖父进程强杀场景。

## 5. 实测（本机，2026-10-31，完整原始数据见 `bench-result.json`）

机器：AMD Radeon 8060S（Radeon 8060S / Strix Halo 级 iGPU）+ XDNA2 NPU；Windows；Node v26.12.1。
资产：FLM 1.0.11 + `qwen3.5:0.8b`；llama.cpp b11871 Vulkan + `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf`。
方法：同一 prompt，`max_tokens=64`，`temperature=0`，非流式；每引擎 3 次取平均；`tok/s = completion_tokens / 总耗时`。

### 5.1 单引擎

| 引擎 | 模型 | 平均 tok/s | 平均总耗时 | 样本（tok/s） |
|---|---|---|---|---|
| NPU（FLM） | qwen3.5:0.8b | **35.15** | 1764 ms | 35.23 / 35.05 / 35.17 |
| GPU（llama.cpp Vulkan） | Qwen2.5-1.5B Q4_K_M | **127.74** | 502 ms | 121.67 / 129.03 / 132.51 |

> 与审计基线一致：NPU 0.8B 约 35–39 tok/s；GPU 端 Vulkan 把 1.5B 跑满、明显快于 NPU，但占用显存与更多功耗。GPU「首 token」约 20 ms（短 prompt、模型常驻），NPU 首 token 约 450 ms。

### 5.2 四模式 × 5 题（单次，`route/race/cascade/augment`）

| 模式 | 平均耗时 | 命中引擎 | 备注 |
|---|---|---|---|
| `route` | 464 ms | GPU 4 / NPU 1 | 翻译题按规则留在 NPU（811 ms） |
| `race` | 345 ms | GPU 5 | 两引擎同发，GPU 更快故全胜；NPU 永远被 abort，不浪费 |
| `cascade` | 1658 ms | NPU 3 / GPU 2（升级） | 两道题 NPU 因 `truncated` 被升级到 GPU 重答（+2.3 s 前后），这正是「别让小模型翻车」的代价 |
| `augment` | 1310 ms | GPU 5（NPU 做增强） | 代码题输出更长（302 字），单题 1.7 s |

`hybrid/bench` 内部对同 prompt 的对比：

| engine | 模式 | tok/s | 首 token |
|---|---|---|---|
| npu | direct | 34.92 | 449 ms |
| gpu | direct | 127.49 | 20 ms |
| hybrid | route | 131.83 | 19 ms |
| hybrid | cascade | 58.22 | 446 ms |
| hybrid | race | 118.51 | 474 ms（返回的是 NPU 的流首 token 时间戳，实际胜者是 GPU） |
| hybrid | augment | 120.38 | 30 ms |

### 5.3 进程归属

| 检查 | 结果 |
|---|---|
| 启动前 `tasklist` | 无 `flm.exe` / `llama-server.exe` |
| `dispose()` 后 `tasklist` | **0 个残留** |
| 端口 | 前端代理 + 两引擎端口全部释放（下次启动重新分配） |
| Job Object | 实测 koffi 可用（`D:\DeepSeek\resources\app.asar.unpacked\dsh\node_modules\koffi`），两进程 `job=on` |

## 6. 局限与风险

1. **小模型能力**：0.8B 用来做「前哨」够快，但涉及推理/代码时截断率高（本轮 5 题里 2 题升级）；cascade 模式必须接受「先花 1.8 s 再花 2.3 s」的最坏情况。
2. **显存/内存**：两引擎各自常驻模型（约 0.6 GB + 1.1 GB），16 GB 内存机型同时开双引擎仍安全，8 GB 机型建议只用 `route` 且 GPU 槽位 `idleSec` 调小。
3. **race 不支持流式**：流式下无法判断「完整答案」，因此 race 只开放非流式；面板会在流式请求时自动降级为 `route`。
4. **接口语义差异**：FLM 与 llama.cpp 对 `max_tokens`、`finish_reason`、usage 字段的实现略有差异，`hybrid.bench` 统一按 OpenAI 形状读取，遇到缺失字段按 0 处理并在 `attempts` 里标注。
5. **ROCm 陷阱**：不要把 `llamacpp-rocm` 当成「AMD 独显必成」——本机 8060S 上 ROCm 会静默回退 CPU 且 `/health` 正常；插件探测时用 `--list-devices` 校验，失败会明确标红并建议 Vulkan。
6. **升级路径**：`cascade` 依赖「首段质量判定」（长度/拒答/重复/截断），这是启发式；换更强的小模型后阈值要重新标定（`HYBRID_DEFAULTS.shortQueryTokens` / `peekChars` / `minAnswerChars`）。

## 7. 与既有四框架的选型

| 你的机器 | 推荐 | 理由 |
|---|---|---|
| 只有 AMD NPU，无独显/核显弱 | `flm`（默认） | NPU 上 0.8B 35+ tok/s，功耗最低 |
| NPU + 核显（本机） | `flm` + `amd-hybrid`（`cascade`） | 短问 NPU、难题 GPU，双引擎都归插件管 |
| 只有 N 卡 | `llamacpp-cuda` | CUDA 运行时后端 |
| 只有 A 卡且是独显 | `llamacpp-vulkan`（优先）/ `rocm` | Vulkan 最稳；ROCm 需 `--list-devices` 验证 |
| 无 NPU 无独显 | `llamacpp-vulkan` 的 CPU 回退 | 能跑但慢，面板会明确标注「CPU 回退」 |