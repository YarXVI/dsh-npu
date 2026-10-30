import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("父进程硬退出后，Job Object 连带杀死模型进程（不留孤儿）", async () => {
  const child = spawn(process.execPath, [path.join(here, "crash-parent.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  const info = JSON.parse(out.trim().split("\n").pop());
  assert.equal(code, 9, "父进程应以 9 退出");
  assert.equal(info.job, true, "Job Object 应该建立成功");
  assert.ok(info.pid > 0);

  await sleep(1200);
  let alive = true;
  try { process.kill(info.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, `父进程崩溃后 pid ${info.pid} 仍活着，说明 Job 没生效`);
});
