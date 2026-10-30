import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NpuSupervisor } from "../lib/supervisor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, "fake-flm.mjs");

test("加载中的模型不会被空闲回收误杀", async () => {
  // 假模型故意延迟 2.5s 才监听，idleSec 只有 1s：
  // 旧实现会在加载期间把 lastUsed=0 当成「空闲太久」直接 kill
  const sup = new NpuSupervisor({
    exePath: process.execPath, frontPort: 0, readyTimeoutSec: 30,
    slots: [{ id: "slow", model: "qwen3.5:0.8b", idleSec: 1,
              args: [fake, "--model", "{model}", "--port", "{port}", "--delay", "2500"] }],
  });
  const front = await sup.start();
  try {
    const r = await fetch(`${front}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3.5:0.8b", messages: [] }),
    });
    assert.equal(r.status, 200, "加载期间不该被杀");
    assert.equal((await r.json()).choices[0].message.content, "pong:qwen3.5:0.8b");
    assert.equal(sup.status().slots[0].running, true);

    await new Promise((res) => setTimeout(res, 2200));
    assert.equal(sup.status().slots[0].running, false, "空闲后应被回收");
  } finally { sup.dispose() }
});
