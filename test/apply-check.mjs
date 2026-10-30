import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL("D:/工作区/dsh-npu/index.js").href);
console.log("name:", mod.name, "| inject:", mod.inject);

const logs = [];
const disposers = [];
let registered = null;
const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push("WARN " + m), error: (m) => logs.push("ERR " + m) },
  effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); },
  llm: { registerAdapter(routes, adapter) { registered = { routes, adapter }; return () => {}; } },
};

try {
  mod.apply(ctx, {
    exePath: "E:/Bonsai2-Lab/fastflowlm/flm.exe",
    frontPort: 52632,
    slots: [{ id: "chat", model: "qwen3.5:0.8b", name: "Q", contextWindow: 8192, reusePort: 52625, args: ["serve","{model}","--port","{port}","--quiet"] }],
  });
  console.log("apply ok | registered routes:", registered && registered.routes);
  console.log("listModels:", JSON.stringify(await registered.adapter.listModels("npu-local")));
  await new Promise((r) => setTimeout(r, 500));
  const r = await fetch("http://127.0.0.1:52632/v1/models");
  console.log("proxy /v1/models:", r.status, (await r.text()).slice(0, 120));
  console.log("logs:", logs.join(" | "));
} catch (e) {
  console.log("APPLY FAILED:", e.message);
} finally {
  for (const d of disposers) { try { d() } catch {} }
}
