import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL("D:/工作区/dsh-npu/index.js").href);
let adapter = null;
const ctx = {
  logger: { info: (m) => console.log("[log]", m), warn: (m) => console.log("[warn]", m) },
  effect(fn) { fn(); },
  llm: { registerAdapter(routes, a) { adapter = a; return () => {}; } },
};
mod.apply(ctx, {
  exePath: "E:/Bonsai2-Lab/fastflowlm/flm.exe",
  frontPort: 52633,
  slots: [
    { id: "chat", model: "qwen3.5:0.8b", name: "Q", contextWindow: 8192, think: false, reusePort: 52625,
      args: ["serve","{model}","--port","{port}","--quiet"] },
  ],
});
await new Promise((r) => setTimeout(r, 400));

const chunks = [];
for await (const c of adapter.stream({
  provider: "npu-local", model: "qwen3.5:0.8b",
  messages: [{ role: "user", content: [{ type: "text", text: "把 hello world 翻译成中文，只输出译文" }] }],
  maxTokens: 32,
})) chunks.push(c);

const text = chunks.filter(c => c.type === "text-delta").map(c => c.text).join("");
const kinds = [...new Set(chunks.map(c => c.type))];
console.log("chunks:", kinds.join(","), "| 块数:", chunks.length);
console.log("text:", JSON.stringify(text));
console.log("usage:", JSON.stringify(chunks.find(c => c.type === "usage")?.usage));
console.log("finish:", JSON.stringify(chunks.at(-1)));
process.exit(0);
