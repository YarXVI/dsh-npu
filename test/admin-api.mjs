import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL("D:/工作区/dsh-npu/index.js").href);
const cfgFile = path.join(os.tmpdir(), "dsh-npu-test.json");
try { fs.unlinkSync(cfgFile) } catch {}

const ctx = {
  logger: { info: () => {}, warn: () => {} },
  effect(fn) { fn(); },
  llm: { registerAdapter: () => () => {} },
};
mod.apply(ctx, {
  exePath: "E:/Bonsai2-Lab/fastflowlm/flm.exe",
  frontPort: 52640,
  configFile: cfgFile,
  slots: [
    { id: "chat", model: "qwen3.5:0.8b", name: "Qwen3.5 0.8B (NPU)", contextWindow: 8192, embed: true, alsoServes: ["embed-gemma:300m"], idleSec: 180, args: ["serve","{model}","--port","{port}","--quiet"] },
    { id: "mt", model: "hy-mt2-flash:1.8b", name: "Hy-MT2 1.8B (NPU)", contextWindow: 1024, idleSec: 60, args: ["serve","{model}","--port","{port}","--quiet"] },
  ],
});
await new Promise((r) => setTimeout(r, 800));

const base = "http://127.0.0.1:52640";
const c = await (await fetch(`${base}/npu/config`)).json();
console.log("config:", c.provider, "| port", c.frontPort, "| slots", c.slots.map(s => `${s.id}:${s.model}:${s.enabled}`).join(", "));

const m = await (await fetch(`${base}/npu/models`)).json();
console.log("models:", m.models.map(x => x.id).join(", "));

const s0 = await (await fetch(`${base}/npu/status`)).json();
console.log("status slots:", s0.slots.map(x => `${x.id}:running=${x.running}`).join(", "));

const put = await fetch(`${base}/npu/config`, {
  method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    frontPort: 52640, provider: "npu-local",
    slots: [
      { id: "chat", model: "qwen3.5:0.8b", name: "Q", contextWindow: 8192, embed: true, idleSec: 180, enabled: true },
      { id: "mt", model: "hy-mt2-flash:1.8b", name: "M", contextWindow: 1024, idleSec: 60, enabled: false },
    ],
  }),
});
console.log("PUT:", put.status, JSON.stringify(await put.json()).slice(0, 160));

const s1 = await (await fetch(`${base}/npu/status`)).json();
console.log("after save slots:", s1.slots.map(x => x.id).join(", "));
console.log("config file:", fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")).slots.map(s => `${s.id}:enabled=${s.enabled}`).join(", ") : "MISSING");

const cors = await fetch(`${base}/npu/config`, { headers: { origin: "http://127.0.0.1:50104" } });
console.log("CORS header:", cors.headers.get("access-control-allow-origin"));
process.exit(0);
