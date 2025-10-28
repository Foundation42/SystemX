import { describe, beforeAll, afterAll, it, expect } from "bun:test";
import { IntegrationClient } from "./testClient";

const TEST_PORT = 18080;
const SERVER_URL = `ws://127.0.0.1:${TEST_PORT}`;

let serverProcess: Bun.Subprocess | null = null;

async function waitForServerReady(url: string, timeoutMs = 5_000) {
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

function attemptConnection(url: string) {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out opening connection"));
    }, 1_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(event);
    });
  });
}

async function createRegisteredClient(address: string) {
  const client = new IntegrationClient(
    new WebSocket(SERVER_URL),
    () => {
      // no-op
    },
  );
  await client.waitForOpen();
  client.send({ type: "REGISTER", address });
  const registered = await client.waitForType("REGISTERED");
  expect(registered).toMatchObject({ address });
  return client;
}

async function startServer() {
  serverProcess = Bun.spawn({
    cmd: ["bun", "run", "src/server.ts"],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SYSTEMX_PORT: String(TEST_PORT),
      SYSTEMX_HOST: "127.0.0.1",
      SYSTEMX_LOG_LEVEL: "error",
    },
  });

  await waitForServerReady(SERVER_URL);
}

async function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

describe("SystemX router integration", () => {
  beforeAll(async () => {
    await startServer();
  });

  afterAll(async () => {
    await stopServer();
  });

  it("supports end-to-end call lifecycle over WebSocket", async () => {
    const alice = await createRegisteredClient("alice.integration@example.com");
    const bob = await createRegisteredClient("bob.integration@example.com");

    alice.send({
      type: "DIAL",
      to: "bob.integration@example.com",
      metadata: { subject: "integration-test" },
    });

    const ring = await bob.waitForType("RING");
    expect(ring).toMatchObject({
      type: "RING",
      from: "alice.integration@example.com",
      metadata: { subject: "integration-test" },
    });
    const callId = ring.call_id;
    expect(typeof callId).toBe("string");

    bob.send({ type: "ANSWER", call_id: callId });
    const connected = await alice.waitForType("CONNECTED");
    expect(connected).toMatchObject({
      type: "CONNECTED",
      call_id: callId,
      to: "bob.integration@example.com",
    });

    alice.send({ type: "MSG", call_id: callId, data: "ping", content_type: "text" });
    const message = await bob.waitForType("MSG");
    expect(message).toMatchObject({
      type: "MSG",
      call_id: callId,
      from: "alice.integration@example.com",
      data: "ping",
      content_type: "text",
    });

    alice.send({ type: "HANGUP", call_id: callId });
    const hangup = await bob.waitForType("HANGUP");
    expect(hangup).toMatchObject({
      type: "HANGUP",
      call_id: callId,
      reason: "normal",
    });

    alice.close();
    bob.close();
  });

  it("notifies the remaining party when a peer disconnects mid-call", async () => {
    const caller = await createRegisteredClient("caller.disconnect@example.com");
    const callee = await createRegisteredClient("callee.disconnect@example.com");

    caller.send({ type: "DIAL", to: "callee.disconnect@example.com" });
    const ring = await callee.waitForType("RING");
    const callId = ring.call_id as string;

    callee.send({ type: "ANSWER", call_id: callId });
    await caller.waitForType("CONNECTED");

    // Simulate abrupt disconnect
    callee.close();

    const hangup = await caller.waitForType("HANGUP", 4_000);
    expect(hangup).toMatchObject({
      type: "HANGUP",
      call_id: callId,
      reason: "peer_disconnected",
    });

    caller.close();
  });
});
