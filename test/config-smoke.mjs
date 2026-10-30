import { NpuSupervisor } from "../lib/supervisor.mjs";
const EXE = "E:\\Bonsai2-Lab\\fastflowlm\\flm.exe";

const sup = new NpuSupervisor({
  exePath: EXE, frontPort: 52634, readyTimeoutSec: 300,
  slots: [{
    id: "chat", model: "qwen3.5:0.8b", think: false, embed: true,
    alsoServes: ["embed-gemma:300m"], idleSec: 0,
    args: ["serve", "{model}", "--port", "{port}", "--quiet"],
  }],
  log: (m) => console.log("[log]", m),
});

const front = await sup.start();
try {
  console.log("models:", (await (await fetch(`${front}/models`)).json()).data.map(d => d.id).join(", "));
  console.log("status before:", JSON.stringify((await (await fetch("http://127.0.0.1:52634/npu/status")).json()).slots));

  const t0 = Date.now();
  const er = await fetch(`${front}/embeddings`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "embed-gemma:300m", input: ["端口怎么配置", "插件安装方法"] }),
  });
  const ej = await er.json();
  console.log("embeddings:", er.status, "n=", ej.data?.length, "dim=", ej.data?.[0]?.embedding?.length, "ms=", Date.now() - t0);

  const cr = await fetch(`${front}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3.5:0.8b", think: false, max_tokens: 16, messages: [{ role: "user", content: "只回复两个字：收到" }] }),
  });
  const cj = await cr.json();
  console.log("chat:", cr.status, JSON.stringify(cj.choices?.[0]?.message?.content));

  const st = await (await fetch("http://127.0.0.1:52634/npu/status")).json();
  console.log("status after:", st.slots.map(s => `${s.id} running=${s.running} port=${s.port}`).join(" | "));
} finally { sup.dispose(); }
