import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL("D:/工作区/dsh-npu/index.js").href);
const cfgFile = path.join(os.tmpdir(), "dsh-npu-test2.json");
try { fs.unlinkSync(cfgFile) } catch {}

// 模拟 DSH：webServer 服务 + inject/scoped.effect
let route = null;
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  effect(fn) { fn(); },
  inject(names, cb) {
    if (!names.includes("webServer")) return;
    const scoped = { get: (n) => n === "webServer" ? { register: (r) => { route = r; return () => { route = null } } } : undefined,
                     effect: (fn2) => { fn2(); return () => {} } };
    cb(scoped);
  },
  llm: { registerAdapter: () => () => {} },
};

mod.apply(ctx, {
  exePath: "E:/Bonsai2-Lab/fastflowlm/flm.exe",
  frontPort: 52641,
  configFile: cfgFile,
  slots: [
    { id: "chat", model: "qwen3.5:0.8b", name: "Qwen3.5 0.8B (NPU)", contextWindow: 8192, embed: true, alsoServes: ["embed-gemma:300m"], idleSec: 180, args: ["serve","{model}","--port","{port}","--quiet"] },
  ],
});
await new Promise((r) => setTimeout(r, 400));

console.log("route mounted:", route ? route.path + " (" + route.kind + ")" : "NONE");

// 假装浏览器同源请求
const mkReq = (method, path) => ({ method, url: path, headers: {} });
const mkRes = () => {
  const out = { code: 0, body: "", headers: {} };
  out.writeHead = (c, hdrs) => { out.code = c; Object.assign(out.headers, hdrs || {}) };
  out.end = (b) => { out.body = b };
  return out;
};

const res1 = mkRes();
await route.handler(mkReq("GET", "/plugins/dsh-npu/panel"), res1);
const j1 = JSON.parse(res1.body);
console.log("GET panel:", res1.code, "| provider", j1.config.provider, "| slots", j1.config.slots.map(s => s.id + ":" + s.model).join(","), "| models", j1.models.length);

const res2 = mkRes();
await route.handler(mkReq("POST", "/plugins/dsh-npu/panel/config"), res2);
console.log("POST(no body):", res2.code);

process.exit(0);
