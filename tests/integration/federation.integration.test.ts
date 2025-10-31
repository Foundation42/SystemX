import { describe, beforeAll, afterAll, it, expect } from "bun:test";
import { IntegrationClient } from "./testClient";
import { startServer, stopServer, type ServerHandle } from "./serverUtils";

const PARENT_PORT = 18100;
const CHILD_PORT = 18101;
const PARENT_HOST = "127.0.0.1";
const CHILD_HOST = "127.0.0.1";

let parentServer: ServerHandle | null = null;
let childServer: ServerHandle | null = null;

async function startFederatedServers() {
  parentServer = await startServer({
    port: PARENT_PORT,
    host: PARENT_HOST,
    logLevel: "error",
  });

  childServer = await startServer({
    port: CHILD_PORT,
    host: CHILD_HOST,
    logLevel: "error",
    env: {
      FEDERATION_ENABLED: "true",
      FEDERATION_PEER_URL: `ws://${PARENT_HOST}:${PARENT_PORT}`,
      FEDERATION_DOMAIN: "home.test",
      FEDERATION_ROUTES: "*@cloud.test",
      FEDERATION_ANNOUNCE_ROUTES: "*@home.test",
      SYSTEMX_LOG_LEVEL: "error",
    },
  });

  // Allow federation handshake to settle
  await Bun.sleep(1_000);
}

async function stopFederatedServers() {
  await stopServer(childServer);
  await stopServer(parentServer);
  childServer = null;
  parentServer = null;
}

async function createRegisteredClient(server: ServerHandle | null, address: string) {
  if (!server) {
    throw new Error("Server handle is missing");
  }
  const client = new IntegrationClient(
    new WebSocket(server.url),
    () => {
      // no-op
    },
  );
  await client.waitForOpen();
  client.send({ type: "REGISTER", address });
  const registered = await client.waitForType("REGISTERED", 5_000);
  expect(registered).toMatchObject({ address });
  return client;
}

describe("SystemX federation integration", () => {
  beforeAll(async () => {
    await startFederatedServers();
  });

  afterAll(async () => {
    await stopFederatedServers();
  });

  it("routes calls from parent exchange to federated child", async () => {
    const cloud = await createRegisteredClient(parentServer, "alice@cloud.test");
    const home = await createRegisteredClient(childServer, "charlie@home.test");

    cloud.send({
      type: "DIAL",
      to: "charlie@home.test",
      metadata: { subject: "parent-to-child" },
    });

    const ring = await home.waitForType("RING", 5_000);
    expect(ring).toMatchObject({
      type: "RING",
      from: "alice@cloud.test",
      metadata: { subject: "parent-to-child" },
    });
    const callId = ring.call_id as string;
    expect(typeof callId).toBe("string");

    home.send({ type: "ANSWER", call_id: callId });

    const connected = await cloud.waitForType("CONNECTED", 5_000);
    expect(connected).toMatchObject({
      type: "CONNECTED",
      call_id: callId,
      to: "charlie@home.test",
    });

    cloud.send({ type: "MSG", call_id: callId, data: "hello downstream", content_type: "text" });
    const msgToHome = await home.waitForType("MSG", 5_000);
    expect(msgToHome).toMatchObject({
      type: "MSG",
      call_id: callId,
      from: "alice@cloud.test",
      data: "hello downstream",
    });

    home.send({ type: "MSG", call_id: callId, data: "ack", content_type: "text" });
    const msgToCloud = await cloud.waitForType("MSG", 5_000);
    expect(msgToCloud).toMatchObject({
      type: "MSG",
      call_id: callId,
      from: "charlie@home.test",
      data: "ack",
    });

    cloud.send({ type: "HANGUP", call_id: callId });
    const hangup = await home.waitForType("HANGUP", 5_000);
    expect(hangup).toMatchObject({
      type: "HANGUP",
      call_id: callId,
      reason: "normal",
    });

    cloud.close();
    home.close();
  });

  it("routes calls from child exchange to parent", async () => {
    const cloud = await createRegisteredClient(parentServer, "bob@cloud.test");
    const home = await createRegisteredClient(childServer, "daisy@home.test");

    home.send({
      type: "DIAL",
      to: "bob@cloud.test",
      metadata: { subject: "child-to-parent" },
    });

    const ring = await cloud.waitForType("RING", 5_000);
    expect(ring).toMatchObject({
      type: "RING",
      from: "daisy@home.test",
      metadata: { subject: "child-to-parent" },
    });
    const callId = ring.call_id as string;
    expect(typeof callId).toBe("string");

    cloud.send({ type: "ANSWER", call_id: callId });
    const connected = await home.waitForType("CONNECTED", 5_000);
    expect(connected).toMatchObject({
      type: "CONNECTED",
      call_id: callId,
      to: "bob@cloud.test",
    });

    home.send({ type: "MSG", call_id: callId, data: "hi upstream", content_type: "text" });
    const msgToCloud = await cloud.waitForType("MSG", 5_000);
    expect(msgToCloud).toMatchObject({
      type: "MSG",
      call_id: callId,
      from: "daisy@home.test",
      data: "hi upstream",
    });

    cloud.send({ type: "MSG", call_id: callId, data: "hello home", content_type: "text" });
    const msgToHome = await home.waitForType("MSG", 5_000);
    expect(msgToHome).toMatchObject({
      type: "MSG",
      call_id: callId,
      from: "bob@cloud.test",
      data: "hello home",
    });

    home.send({ type: "HANGUP", call_id: callId });
    const hangup = await cloud.waitForType("HANGUP", 5_000);
    expect(hangup).toMatchObject({
      type: "HANGUP",
      call_id: callId,
      reason: "normal",
    });

    cloud.close();
    home.close();
  });
});
