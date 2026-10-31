import { test } from "node:test";
import assert from "node:assert";
import { createAdapter } from "../lib/adapter.mjs";

test("providerInfo 原样带回 id 且 name 非空（llm 注册时会校验）", () => {
  const a = createAdapter({ baseURL: "http://127.0.0.1:1/v1", models: [], displayName: "本机 NPU" });
  const info = a.providerInfo("npu-local");
  assert.equal(info.id, "npu-local");
  assert.equal(info.name, "本机 NPU");
  assert.equal(typeof a.providerRetryPolicy("npu-local"), "undefined");
});

test("providerInfo 没配 displayName 时也有非空 name", () => {
  const a = createAdapter({ baseURL: "http://127.0.0.1:1/v1", models: [] });
  assert.ok(a.providerInfo("npu-local").name.length > 0);
});
