import { test } from "node:test";
import assert from "node:assert";
import net from "node:net";
import { NpuSupervisor } from "../lib/supervisor.mjs";

test("端口被占用时自动改用系统端口，而不是把宿主带崩", async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const taken = blocker.address().port;

  const sup = new NpuSupervisor({ exePath: process.execPath, frontPort: taken, slots: [], readyTimeoutSec: 5 });
  try {
    const front = await sup.start();              // 不抛错，而是换端口
    const actual = Number(new URL(front).port);
    assert.ok(actual > 0);
    assert.notEqual(actual, taken, "应该换到一个不同于被占端口的端口");

    const r = await fetch(`${front}/models`);
    assert.equal(r.status, 200, "换端口后仍然要能服务");
  } finally {
    sup.dispose();
    await new Promise((r) => blocker.close(r));
  }
});
