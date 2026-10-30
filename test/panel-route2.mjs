import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL("D:/工作区/dsh-npu/index.js").href);
const cfgFile = path.join(os.tmpdir(), "dsh-npu-test3.json");
try { fs.unlinkSync(cfgFile) } catch {}

let route = null;
const ctx = {
  logger: { info: () => {} },
  effect(fn) { fn(); },
  inject(names, cb) {
    if (!names.includes("webServer")) return;
    cb({ get: () => ({ register: (r) => { route = r; return () => { route = null } } }), effect: (f) => { f(); return () => {} } });
  },
  llm: { registerAdapter: () => () => {} },
};
mod.apply(ctx, {
  exePath: "E:/Bonsai2-Lab/fastflowlm/flm.exe", frontPort: 52642, configFile: cfgFile,
  slots: [{ id: "chat", model: "qwen3.5:0.8b", name: "Q", contextWindow: 8192, embed: true, idleSec: 180, args: ["serve","{model}","--port","{port}","--quiet"] }],
});
await new Promise((r) => setTimeout(r, 300));

const call = (method, path2, body) => new Promise((resolve) => {
  const req = new EventEmitter();
  req.method = method; req.url = path2; req.headers = {};
  const res = { code: 0, payload: "", writeHead(c) { this.code = c }, end(b) { this.payload = b; resolve({ code: this.code, json: JSON.parse(b) }) } };
  route.handler(req, res);
  if (body !== undefined) { req.emit("data", JSON.stringify(body)); }
  req.emit("end");
});

const g = await call("GET", "/plugins/dsh-npu/panel");
console.log("GET:", g.code, "| slots", g.json.config.slots.map(s => s.id).join(","), "| models", g.json.models.length);

const empty = await call("POST", "/plugins/dsh-npu/panel/config", {});
console.log("POST empty ->", empty.code, empty.json.error && empty.json.error.message);

const ok = await call("POST", "/plugins/dsh-npu/panel/config", {
  provider: "npu-local", frontPort: 52642,
  slots: [{ id: "chat", model: "qwen3.5:0.8b", name: "Q", enabled: false }],
});
console.log("POST real ->", ok.code, "| restartRequired", ok.json.restartRequired, "| enabled", ok.json.config.slots[0].enabled);
console.log("file:", fs.readFileSync(cfgFile, "utf8").replace(/\s+/g, " ").slice(0, 120));
process.exit(0);
