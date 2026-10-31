import path from "node:path";
import { pathToFileURL } from "node:url";

const here = "D:/工作区/dsh-npu";
const fake = path.join(here, "test/fake-flm.mjs");
const mod = await import(pathToFileURL(path.join("C:/Users/shens/.dsh/profiles/desktop/node_modules/@local/dsh-npu/index.js")).href);

let dispose = null;
const logs = [];
const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push("WARN " + m) },
  effect(fn) { dispose = fn(); },
};

console.log("plugin name:", mod.name, "| apply:", typeof mod.apply);
mod.apply(ctx, {
  exePath: process.execPath,
  frontPort: 52631,
  koffiPath: "D:/DeepSeek/resources/app.asar.unpacked/dsh/node_modules/koffi",
  slots: [{ id: "chat", model: "qwen3.5:0.8b", idleSec: 3, args: [fake, "--model", "{model}", "--port", "{port}"] }],
});

await new Promise((r) => setTimeout(r, 600));
const models = await (await fetch("http://127.0.0.1:52631/v1/models")).json();
console.log("models:", models.data.map((d) => d.id).join(","));

const r = await fetch("http://127.0.0.1:52631/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "qwen3.5:0.8b", messages: [{ role: "user", content: "hi" }] }),
});
const j = await r.json();
console.log("chat:", r.status, j.choices?.[0]?.message?.content);

console.log("logs:", logs.join(" | "));
dispose && dispose();
await new Promise((r) => setTimeout(r, 300));
console.log("disposed ok");
