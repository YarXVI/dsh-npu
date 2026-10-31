import { test } from "node:test";
import assert from "node:assert";
import { createAdapter } from "../lib/adapter.mjs";

// 这两段是照着 dsh-llm 的 prepareRoutes / normalizeModelInfo 抄的校验，
// 用来在没有真宿主的情况下证明 adapter 能过注册。
function prepareRoutes(providers, adapter, registered = new Set()) {
  const unique = new Set();
  const out = [];
  for (const provider of providers) {
    if (provider.length === 0) throw new Error("adapter provider names must be non-empty");
    if (unique.has(provider) || registered.has(provider)) throw new Error("DUPLICATE_ADAPTER");
    const info = adapter.providerInfo(provider);
    if (typeof info.id !== "string" || info.id !== provider ||
        typeof info.name !== "string" || info.name.length === 0) {
      throw new Error("INVALID_ADAPTER: metadata must preserve id and have non-empty name");
    }
    unique.add(provider);
    out.push({ provider: { id: info.id, name: info.name }, retryPolicy: adapter.providerRetryPolicy(provider) });
  }
  return out;
}

function normalizeModelInfo(provider, model, resolved) {
  if (typeof resolved.provider !== "string" || resolved.provider !== provider) throw new Error("INVALID_MODEL_INFO provider");
  if (typeof resolved.id !== "string" || resolved.id !== model) throw new Error("INVALID_MODEL_INFO id");
  if (typeof resolved.name !== "string" || resolved.name.length === 0) throw new Error("INVALID_MODEL_INFO name");
  const context = resolved.context;
  if (context !== undefined && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) {
    throw new Error("INVALID_MODEL_CONTEXT");
  }
  return resolved;
}

const MODELS = [
  { id: "qwen3.5:0.8b", name: "Qwen3.5 0.8B (NPU)", contextWindow: 8192 },
  { id: "hy-mt2-flash:1.8b", name: "Hy-MT2 1.8B (NPU)", contextWindow: 1024 },
];

test("adapter 能通过 dsh-llm 的注册校验", () => {
  const a = createAdapter({ baseURL: "http://127.0.0.1:1/v1", models: MODELS, displayName: "本机 NPU" });
  const routes = prepareRoutes(["npu-local"], a);
  assert.deepEqual(routes, [{ provider: { id: "npu-local", name: "本机 NPU" }, retryPolicy: undefined }]);
});

test("重复注册同一个 provider 会被识别", () => {
  const a = createAdapter({ baseURL: "http://127.0.0.1:1/v1", models: MODELS });
  assert.throws(() => prepareRoutes(["npu-local"], a, new Set(["npu-local"])), /DUPLICATE_ADAPTER/);
});

test("listModels 的每个条目都能过目录校验，且 id 不重复", async () => {
  const a = createAdapter({ baseURL: "http://127.0.0.1:1/v1", models: MODELS });
  const list = await a.listModels("npu-local");
  const seen = new Set();
  for (const m of list) {
    assert.equal(m.provider, "npu-local");
    assert.ok(m.id.length > 0 && m.name.length > 0);
    assert.ok(!seen.has(m.id));
    seen.add(m.id);
  }
  assert.equal(list.length, 2);
});

test("resolveModel / prepareCall 的元数据能过 normalizeModelInfo", async () => {
  const a = createAdapter({ baseURL: "http://127.0.0.1:1/v1", models: MODELS });
  for (const m of MODELS) {
    normalizeModelInfo("npu-local", m.id, await a.resolveModel("npu-local", m.id));
    const call = await a.prepareCall("npu-local", m.id);
    normalizeModelInfo("npu-local", m.id, call.model);
    assert.equal(typeof call.stream, "function");
  }
});
