# 燧心 · Hearthcore（`dsh-npu`）

> DeepSeek Harness 的本机推理插件。让 AMD NPU 与 GPU 上的本地模型**随 DSH 起退**：想用时点火，用完熄火，退出零残留；面板、模型、框架、端口全部在一个插件里。
>
> MIT · 无云、无遥测、无第三方窗口、无链式启动器。

**第五框架 `amd-hybrid`**：不用加载器、不开第二个窗口，在同一条 DSH 生命周期里同时驾驭 NPU（FastFlowLM）与 GPU（llama.cpp），按路由 / 竞速 / 级联 / 增强四种方式协同，对外仍只有一个 OpenAI 兼容端口。

| 引擎 | 平台 | 实测（本机，2026-10） |
|---|---|---|
| FLM（XDNA2 NPU） | AMD Ryzen AI | `qwen3.5:0.8b` **35.15 tok/s**，首 token ~450 ms |
| llama.cpp Vulkan | AMD / Intel / NVIDIA | `Qwen2.5-1.5B Q4` **127.7 tok/s**，首 token ~20 ms |
| llama.cpp ROCm | AMD 独显 | 本机核显会静默回退 CPU，面板用 `--list-devices` 校验后标红 |
| llama.cpp CUDA | NVIDIA | 运行时按需下载 |
| **amd-hybrid（第五框架）** | NPU + GPU 同时 | `route` 464 ms / `race` 345 ms（见下） |

## 为什么需要它

本地推理的痛点从来不是「模型跑不起来」，而是**跑起来之后留下的烂摊子**：

1. **进程孤儿**：启动器退出、模型进程还在，占着显存与端口；下次启动又起一份。
2. **多窗口**：LM Studio / Ollama / Lemonade 各有一个窗口，切换模型要去点别人的 UI。
3. **配置黑盒**：模型清单、上下文、embedding、翻译槽位散落在多个配置文件里，改一个地方不生效。
4. **ROCm 静默降级**：`/health` 200 看着正常，实际在 CPU 上跑。
5. **面板骗人**：点「加载模型」只改了一个字段，其余元数据还是旧的。
6. **NPU 与 GPU 只能二选一**：小模型 NPU 快但会翻车，大模型 GPU 强但耗电。

燧心的做法：**一个入口、一个配置 schema、一张路由表、一个第五框架、三个页签**；所有进程归 DSH 的 Job Object 管；面板上每一个数字都来自真实探测。

## 安装

```bash
# 方式一：插件市场
#   DSH → 插件 → 发现 → 添加索引源：https://yarxvi.github.io/dsh-npu/market/index.json → 安装「燧心 · 本地推理」

# 方式二：git（锁定提交，可复现）
dsh plugin add git+https://github.com/YarXVI/dsh-npu.git#<commit>

# 方式三：本地开发（link）
dsh plugin add link:./plugins/dsh-npu
```

依赖：Node ≥ 20；AMD NPU 需装 [FastFlowLM](https://github.com/FastFlowLM/FastFlowLM)；GPU 引擎的 llama.cpp 运行时由插件自己下载（`runtimes/`），不需要 Ollama。

## 上手（5 分钟）

1. 打开 **插件 → 燧心 · 本地推理**（侧栏入口）。
2. 「设置 → 运行环境」填 `flm.exe` 绝对路径，或点「自动查找」（有界扫盘，不扫全盘）。
3. 「模型 → 后端」点「安装 Vulkan 运行时」（约 35 MB），或直接用 NPU。
4. 「概览 → 一键点火」：起代理、注册 provider、把模型暴露给 DSH 的模型选择器。
5. 在 DSH 里选 `npu-local` 的模型即可对话；面板「设置 → 混合推理」切 `route / race / cascade / augment`。

## 第五框架怎么选

| 模式 | 行为 | 适合 |
|---|---|---|
| `route` | 翻译/embedding → NPU，代码/长文 → GPU，失败自动换引擎 | 日常单请求 |
| `race` | 两引擎同发，先给完整答案者胜（仅非流式） | 尾延迟敏感 |
| `cascade` | NPU 先答首段；拒答/截断/退化 → GPU 重答 | 省 GPU 占用 |
| `augment` | GPU 主答，NPU 并行做检索/翻译/摘要增强 | 长上下文 |

本机实测（同一 prompt、`max_tokens=64`、`temperature=0`）：`route` 平均 464 ms，`race` 345 ms，`cascade` 1658 ms（两题因 NPU 截断升级），`augment` 1310 ms。完整原始数据见 `bench/bench-result.json`（由 `bench/bench.mjs` 生成）。

## 配置（schema v2）

单文件：`~/.dsh/dsh-npu.json`（可用 `configFile` 或 `DSH_NPU_DATA` 改位置）。v1 → v2 自动迁移，迁移前在同目录留 `dsh-npu.json.v1-<时间戳>.bak`；归一化会自愈重复槽位 id、去重同模型、把缺失模型标 `stale`（**不静默改你的选择**）。

```json
{
  "schema": 2,
  "provider": "npu-local",
  "displayName": "燧心 · 本地推理",
  "dataRoot": "D:\\dsh-npu-data",
  "mode": "auto",
  "hybrid": { "enabled": true, "mode": "auto", "draftModel": "qwen3.5:0.8b", "verifyModel": "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf" },
  "frontPort": 52630,
  "bindHost": "127.0.0.1",
  "slots": [
    { "id": "chat", "backend": "flm", "model": "qwen3.5:0.8b", "contextWindow": 8192, "embed": true, "alsoServes": ["embed-gemma:300m"] },
    { "id": "mt", "backend": "flm", "model": "hy-mt2-flash:1.8b", "contextWindow": 1024 },
    { "id": "gpu", "backend": "llamacpp-vulkan", "model": "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf", "contextWindow": 4096 }
  ]
}
```

槽位字段：`backend`（`flm` / `llamacpp-vulkan` / `-rocm` / `-cuda`）、`model`、`name`、`contextWindow`、`think`、`embed`、`alsoServes`、`idleSec`、`enabled`、`llm`、`args`、`stale`。`apiToken` 保存后**立即生效**（不需要重启）。

## HTTP

**OpenAI 兼容**（一个端口，默认 `52630`，只绑 loopback）：

- `POST /v1/chat/completions`、`POST /v1/completions`、`POST /v1/embeddings`、`GET /v1/models`
- 支持流式（`stream:true`，SSE）；`cascade` 在升级前不吐字，`race` 仅非流式。

**面板 API**（挂在 DSH 同源 `/plugins/dsh-npu/panel`，旧 `/npu/*` 保留为别名）：

`state` / `config` / `health` / `models` / `model/select` / `backends` / `backend` / `runtime/download` / `model/download` / `model/delete` / `slot/warm` / `slot/evict` / `hybrid/status` / `hybrid/config` / `hybrid/bench` / `updates` / `updates/check` / `update` / `startup-args(+reload/reset/open)` / `logs` / `logs/open` / `diagnostics`

所有成功返回 `{ok:true,...}`，失败返回 `{ok:false,error:{message}}`；面板「自检」逐项对应 `health.items[]`。

## 进程归属（这是本插件的核心承诺）

- `NpuSupervisor` 用 `spawn` 起每个模型进程，创建即加入 **Windows Job Object（kill-on-close）**；DSH 退出或被杀 → 内核连带终止整棵子树。
- 子进程再 spawn 的孙进程也在同一 Job 里；`test/jobtree.test.mjs` 与 `bench/job-proof.mjs` 覆盖强杀场景。
- 空闲回收：槽位 `idleSec` 到点自动熄火（`busy>0` 不回收）；面板「熄火」立即回收。
- 不存在「链式启动器」：不调用任何外部 exe 去拉模型、不注册服务、不写自启。

## 模型怎么选

| 用途 | 模型 | 说明 |
|---|---|---|
| 通用对话 / 整理 | `qwen3.5:0.8b`（FLM） | 0.8B 中文稳，NPU 35 tok/s |
| 整段翻译 | `hy-mt2-flash:1.8b`（FLM） | 数字/日期/代码保真最好，1k 上下文 |
| 语义检索 | `embed-gemma:300m` | 挂在 chat 进程上（`embed:true`），不单独起进程 |
| 代码 / 长文 / 混合主答 | `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf` | GPU Vulkan，127 tok/s |

## 常见问题

- **面板显示「未找到 flm.exe」**：填绝对路径；FLM 便携版不在 PATH 是常态。
- **端口被占用**：插件会自动改用系统分配端口并在面板显示实际端口，不会崩。
- **ROCm 后端「能跑」但很慢**：大概率回退 CPU，看面板后端行里的 `--list-devices` 探测结果。
- **混合推理不可用**：需要 NPU 槽位 + GPU 槽位（llama.cpp 运行时 + gguf）都在；自检会指出缺哪一项。
- **换机器**：把 `dataRoot` 指到外置盘/旧目录即可，模型不搬家。

## 目录

```
index.js            入口（装配 + 生命周期，薄层）
client.js           面板（React，三页签）
lib/config.mjs      配置 schema v2 / 迁移 / 自愈 / 原子写
lib/panel-api.mjs   唯一路由表（面板 + 旧 /npu/* 别名）
lib/supervisor.mjs  进程与代理（Job Object、空闲回收、鉴权）
lib/hybrid.mjs      第五框架（route/race/cascade/augment）
lib/backend-service.mjs  后端解析、运行时/模型下载、删除到回收站
lib/probe.mjs       健康自检（10 项）
lib/provider.mjs    DSH provider 注册 / 热重建
lib/framework-update.mjs  框架更新检查与安装
lib/startup-args.mjs      启动参数文件（可视化编辑）
test/               101 条 node:test（全绿）
```

## 许可

MIT。不含任何模型权重；模型由用户自行下载/授权。本插件不做联网推理，除非用户显式配置云端 provider（与本插件无关）。