import { describe, beforeAll, afterAll, it, expect } from "bun:test";
import { IntegrationClient } from "./testClient";
import { startServer as startSystemXServer, stopServer as stopSystemXServer, type ServerHandle } from "./serverUtils";

const TEST_PORT = 18080;

let serverHandle: ServerHandle | null = null;

function getServerUrl(): string {
  if (!serverHandle) {
    throw new Error("Server is not running");
  }
  return serverHandle.url;
}

async function createRegisteredClient(address: string) {
  if (!serverHandle) {
    throw new Error("Server is not running");
  }
  const client = new IntegrationClient(
    new WebSocket(serverHandle.url),
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

async function startServer(envOverrides: Record<string, string> = {}) {
  serverHandle = await startSystemXServer({
    port: TEST_PORT,
    env: envOverrides,
  });
}

async function stopServer() {
  await stopSystemXServer(serverHandle);
  serverHandle = null;
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

  it("enforces configured call timeout", async () => {
    await stopServer();
    await startServer({ SYSTEMX_CALL_TIMEOUT: "100" });

    const caller = await createRegisteredClient("caller.timeout@example.com");
    const callee = await createRegisteredClient("callee.timeout@example.com");

    caller.send({ type: "DIAL", to: "callee.timeout@example.com" });

    await callee.waitForType("RING");

    const busy = await caller.waitForType("BUSY", 5_000);
    expect(busy).toMatchObject({
      type: "BUSY",
      to: "callee.timeout@example.com",
      reason: "timeout",
    });

    const hangup = await callee.waitForType("HANGUP", 1_000);
    expect(hangup).toMatchObject({
      type: "HANGUP",
      reason: "timeout",
    });

    caller.close();
    callee.close();

    await stopServer();
    await startServer();
  });

  it("closes connection on malformed JSON", async () => {
    const rawSocket = new WebSocket(getServerUrl());
    await new Promise<void>((resolve, reject) => {
      rawSocket.addEventListener("open", () => resolve(), { once: true });
      rawSocket.addEventListener("error", (err) => reject(err), { once: true });
    });

    rawSocket.send("not-json");

    await new Promise<void>((resolve, reject) => {
      rawSocket.addEventListener(
        "close",
        (event) => {
          expect(event.code).toBe(1003);
          resolve();
        },
        { once: true },
      );
      setTimeout(() => reject(new Error("Expected server to close connection")), 1_000);
    });
  });

  it("returns error for unsupported MSG content type", async () => {
    const caller = await createRegisteredClient("caller.invalidmsg@example.com");
    const callee = await createRegisteredClient("callee.invalidmsg@example.com");

    caller.send({ type: "DIAL", to: "callee.invalidmsg@example.com" });
    const ring = await callee.waitForType("RING");
    const callId = ring.call_id as string;

    callee.send({ type: "ANSWER", call_id: callId });
    await caller.waitForType("CONNECTED");

    caller.send({ type: "MSG", call_id: callId, data: "hi", content_type: "xml" });
    const error = await caller.waitForType("ERROR");
    expect(error).toMatchObject({
      type: "ERROR",
      reason: "invalid_payload",
      context: "MSG",
    });

    caller.close();
    callee.close();
  });

  it("rate limits repeated dial attempts", async () => {
    await stopServer();
    await startServer({
      SYSTEMX_DIAL_MAX_ATTEMPTS: "2",
      SYSTEMX_DIAL_WINDOW_MS: "1000",
    });

    const caller = await createRegisteredClient("caller.ratelimit@example.com");

    for (let i = 0; i < 3; i += 1) {
      caller.send({ type: "DIAL", to: "nobody@example.com" });
      await Bun.sleep(50);
    }

    const error = await caller.waitForType("ERROR", 2_000);
    expect(error).toMatchObject({
      type: "ERROR",
      reason: "rate_limited",
      context: "DIAL",
    });

    caller.close();

    await stopServer();
    await startServer();
  });
});
