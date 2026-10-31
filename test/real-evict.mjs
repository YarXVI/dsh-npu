import { NpuSupervisor } from "../lib/supervisor.mjs";
const EXE = "E:\\Bonsai2-Lab\\fastflowlm\\flm.exe";
const log = [];
const sup = new NpuSupervisor({
  exePath: EXE, frontPort: 52637, readyTimeoutSec: 300,
  slots: [{ id: "chat", model: "qwen3.5:0.8b", think: false, idleSec: 4,
            args: ["serve", "{model}", "--port", "{port}", "--quiet"] }],
  log: (m) => { log.push(m); console.log("[log]", m); },
});
const front = await sup.start();
const before = (await (await fetch("http://127.0.0.1:52637/npu/status")).json()).slots[0];
console.log("请求前 running=" + before.running + " starts=" + before.starts);

const t0 = Date.now();
const r = await fetch(`${front}/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "qwen3.5:0.8b", think: false, max_tokens: 12,
    messages: [{ role: "user", content: "只回复两个字：在线" }] }),
});
const j = await r.json();
const after = (await (await fetch("http://127.0.0.1:52637/npu/status")).json()).slots[0];
console.log("请求后 running=" + after.running + " pid=" + after.pid + " 冷启动耗时=" + (Date.now() - t0) + "ms");
console.log("回复:", JSON.stringify(j.choices?.[0]?.message?.content));

await new Promise((res) => setTimeout(res, 7000));
const idle = (await (await fetch("http://127.0.0.1:52637/npu/status")).json()).slots[0];
console.log("空闲 7s 后 running=" + idle.running + " pid=" + idle.pid);
sup.dispose();
process.exit(0);
