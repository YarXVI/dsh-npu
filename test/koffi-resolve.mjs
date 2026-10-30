import { createKillJob } from "../lib/supervisor.mjs";
// 模拟 Electron 主进程：resourcesPath 指向 DSH 安装目录
const before = process.resourcesPath;
Object.defineProperty(process, "resourcesPath", { value: "D:\\DeepSeek\\resources", configurable: true });
const logs = [];
const job = createKillJob("", (m) => logs.push(m));
console.log("job:", job ? "created" : "NULL", "| logs:", logs.join(" ; "));
job?.close();
Object.defineProperty(process, "resourcesPath", { value: before, configurable: true });
