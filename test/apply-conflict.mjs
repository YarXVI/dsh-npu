import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL("D:/工作区/dsh-npu/index.js").href);
const logs = [];
const ctx = {
  logger: { info: (m) => logs.push(m) },
  effect(fn) { fn(); },
  llm: { registerAdapter() { throw new Error("DUPLICATE_ADAPTER: npu-local 已被占用"); } },
};
mod.apply(ctx, { exePath: process.execPath, frontPort: 52636,
  slots: [{ id: "chat", model: "qwen3.5:0.8b", args: ["test/fake-flm.mjs","--model","{model}","--port","{port}"] }] });
await new Promise(r => setTimeout(r, 600));
const ok = await fetch("http://127.0.0.1:52636/v1/models").then(r => r.status).catch(() => "DOWN");
console.log("路由注册失败后，代理端口:", ok);
console.log("日志:", logs.join(" | "));
process.exit(0);

