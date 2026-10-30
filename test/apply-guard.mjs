import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL("D:/工作区/dsh-npu/index.js").href);
const logs = [];
const disposers = [];
let routes = null;
const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push("WARN " + m) },
  effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); },
  llm: { registerAdapter(r, a) { routes = r; return () => {}; } },
  tools: { register(t) { return () => {}; } },
};
mod.apply(ctx, {
  exePath: "E:/Bonsai2-Lab/fastflowlm/flm.exe", frontPort: 52635,
  slots: [{ id: "chat", model: "qwen3.5:0.8b", alsoServes: ["embed-gemma:300m"], embed: true,
            args: ["serve","{model}","--port","{port}","--quiet"] }],
});
await new Promise(r => setTimeout(r, 300));
console.log("routes:", routes);
console.log("logs:", logs.join(" | "));
for (const d of disposers) { try { d() } catch (e) { console.log("dispose err:", e.message) } }
