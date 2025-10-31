import type { Subprocess } from "bun";

export type ServerHandle = {
  process: Subprocess;
  port: number;
  host: string;
  url: string;
};

async function attemptConnection(url: string) {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out opening connection"));
    }, 1_000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      (event) => {
        clearTimeout(timer);
        reject(event);
      },
      { once: true },
    );
  });
}

export async function waitForServerReady(url: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await attemptConnection(url);
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(100);
    }
  }

  throw new Error(`Server did not become ready: ${lastError}`);
}

export async function startServer(options: {
  port: number;
  host?: string;
  env?: Record<string, string | undefined>;
  logLevel?: string;
}): Promise<ServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port;
  const url = `ws://${host}:${port}`;
  const logLevel = options.logLevel ?? "error";

  const subprocess = Bun.spawn({
    cmd: ["bun", "run", "src/server.ts"],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SYSTEMX_PORT: String(port),
      SYSTEMX_HOST: host,
      SYSTEMX_LOG_LEVEL: logLevel,
      ...options.env,
    },
  });

  await waitForServerReady(url);

  return { process: subprocess, port, host, url };
}

export async function stopServer(handle: ServerHandle | null | undefined) {
  if (!handle) {
    return;
  }
  const { process } = handle;
  try {
    process.kill();
  } catch {
    // ignore errors if process already exited
  }
  try {
    await process.exited;
  } catch {
    // swallow errors on exit
  }
}
