import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NpuSupervisor } from "../lib/supervisor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, "fake-flm.mjs");

// 注意：token 只拦「局域网来源」。本机（127.0.0.1 / ::1）一律豁免，
// 免得浏览器扩展和本地脚本都得跟着加 Authorization 头。
// 局域网那侧的规则由 test/lan.test.mjs 覆盖。

test("配了 apiToken 也不影响本机调用", async () => {
  const sup = new NpuSupervisor({
    exePath: process.execPath,
    frontPort: 0,
    apiToken: "s3cret",
    readyTimeoutSec: 20,
    slots: [{ id: "chat", model: "qwen3.5:0.8b", idleSec: 0, args: [fake, "--model", "{model}", "--port", "{port}"] }],
  });
  const front = await sup.start();
  try {
    const ok = await fetch(`${front}/models`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).data.length, 1);

    const chat = await fetch(`${front}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3.5:0.8b", messages: [] }),
    });
    assert.equal(chat.status, 200);
  } finally { sup.dispose() }
});

test("/npu/status 不需要拉起模型就能看到状态", async () => {
  const sup = new NpuSupervisor({
    exePath: process.execPath, frontPort: 0, readyTimeoutSec: 20,
    slots: [{ id: "chat", model: "qwen3.5:0.8b", idleSec: 0, args: [fake, "--model", "{model}", "--port", "{port}"] }],
  });
  const front = await sup.start();
  try {
    const base = front.replace(/\/v1$/, "");
    const st = await (await fetch(`${base}/npu/status`)).json();
    assert.equal(st.slots[0].running, false);
    assert.equal(st.slots[0].starts, 0);
  } finally { sup.dispose() }
});

test("跨站 Origin 与 text/plain 写请求被拒绝（CSRF/DNS rebinding 防护）", async () => {
  const sup = new NpuSupervisor({
    exePath: process.execPath, frontPort: 0, readyTimeoutSec: 20,
    slots: [{ id: "chat", model: "qwen3.5:0.8b", idleSec: 0, args: [fake, "--model", "{model}", "--port", "{port}"] }],
  });
  const front = await sup.start();
  try {
    const base = front.replace(/\/v1$/, "");
    const evil = await fetch(`${base}/npu/config`, { headers: { origin: "http://evil.example" } });
    assert.equal(evil.status, 403);
    const plain = await fetch(`${base}/npu/config`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ displayName: "x" }),
    });
    assert.equal(plain.status, 415);
  } finally { sup.dispose() }
});

test("未知模型名不再静默落到第一个槽位", async () => {
  const sup = new NpuSupervisor({
    exePath: process.execPath, frontPort: 0, readyTimeoutSec: 20,
    slots: [{ id: "chat", model: "qwen3.5:0.8b", idleSec: 0, args: [fake, "--model", "{model}", "--port", "{port}"] }],
  });
  const front = await sup.start();
  try {
    const r = await fetch(`${front}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "llama3:70b", messages: [] }),
    });
    assert.equal(r.status, 503);
  } finally { sup.dispose() }
});
