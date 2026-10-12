import { spawn } from "node:child_process";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const serverFile = fileURLToPath(new URL("../web-demo/server.js", import.meta.url));
const runtime = fileURLToPath(new URL("../.resume-agent-runtime/", import.meta.url));
const port = Number(process.env.RESUME_AGENT_DEMO_PORT || 4174);
const action = process.argv[2] || "status";
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RangeError("Invalid local demo port");
if (!["start", "stop", "status"].includes(action)) throw new Error("Use start, stop, or status");
const url = `http://127.0.0.1:${port}`;
const stateFile = `${runtime}demo-${port}.json`;
const logFile = `${runtime}demo-${port}.log`;

async function health() {
  try {
    const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function savedProcess() {
  try { return JSON.parse(await readFile(stateFile, "utf8")); }
  catch { return null; }
}

if (action === "status") {
  const current = await health();
  console.log(current?.serviceId === "resume-agent-demo" ? `运行中：${url}（PID ${current.pid}）` : `未运行：${url}`);
} else if (action === "start") {
  const current = await health();
  if (current) {
    if (current.serviceId !== "resume-agent-demo") throw new Error(`Port ${port} is used by another service`);
    console.log(`已在运行：${url}（PID ${current.pid}）`);
  } else {
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const log = await open(logFile, "a", 0o600);
    const child = spawn(process.execPath, [serverFile], {
      cwd: root,
      env: { ...process.env, RESUME_AGENT_DEMO_PORT: String(port) },
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
    await log.close();
    if (!child.pid) throw new Error("Could not start the local demo server");
    await writeFile(stateFile, JSON.stringify({ pid: child.pid, port }) + "\n", { mode: 0o600 });
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = await health();
      if (status?.serviceId === "resume-agent-demo" && status.pid === child.pid) { ready = true; break; }
    }
    if (!ready) throw new Error(`Demo server did not start; inspect ${logFile}`);
    console.log(`已启动：${url}/?runner=browser-use（PID ${child.pid}）`);
  }
} else {
  const saved = await savedProcess();
  const current = await health();
  if (!saved || current?.serviceId !== "resume-agent-demo" || current.pid !== saved.pid) {
    throw new Error(`No matching managed demo server on port ${port}; nothing was stopped`);
  }
  process.kill(saved.pid, "SIGTERM");
  await unlink(stateFile);
  console.log(`已停止本机演示服务（PID ${saved.pid}）`);
}
