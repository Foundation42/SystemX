import { describe, expect, it, beforeEach } from "bun:test";
import { SystemXRouter } from "../src/router";
import { RouterOptions } from "../src/types";
import type { Logger } from "../src/logger";
import { randomUUID } from "crypto";

type SentMessage = Record<string, any>;

class TestTransport {
  public readonly sent: SentMessage[] = [];
  public closed: { code?: number; reason?: string } | null = null;

  send(message: SentMessage) {
    this.sent.push(message);
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }

  getMessagesOfType(type: string) {
    return this.sent.filter((msg) => msg.type === type);
  }
}

const defaultOptions: RouterOptions = {
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  logger: createSilentLogger(),
  callRingingTimeoutMs: 5_000,
};

function createSilentLogger(): Logger {
  const noop = () => {};
  return {
    level: "error",
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
}

function createTestConnection(router: SystemXRouter) {
  const transport = new TestTransport();
  const connection = router.createConnection({
    id: randomUUID(),
    transport,
  });
  return { transport, connection };
}

function registerAddress(router: SystemXRouter, connection: ReturnType<typeof createTestConnection>["connection"], address: string) {
  router.handleMessage(connection, {
    type: "REGISTER",
    address,
  });
}

describe("SystemXRouter registration", () => {
  let router: SystemXRouter;

  beforeEach(() => {
    router = new SystemXRouter(defaultOptions);
  });

  it("registers a new address and acknowledges the client", () => {
    const { transport, connection } = createTestConnection(router);
    registerAddress(router, connection, "alice@example.com");

    expect(transport.sent).toHaveLength(1);
    const response = transport.sent[0];
    expect(response).toMatchObject({
      type: "REGISTERED",
      address: "alice@example.com",
    });
    expect(typeof response["session_id"]).toBe("string");
  });

  it("rejects registrations for addresses that are already in use", () => {
    const first = createTestConnection(router);
    registerAddress(router, first.connection, "alice@example.com");

    const second = createTestConnection(router);
    registerAddress(router, second.connection, "alice@example.com");

    expect(second.transport.sent).toHaveLength(1);
    expect(second.transport.sent[0]).toEqual({
      type: "REGISTER_FAILED",
      reason: "address_in_use",
    });
  });
});

describe("SystemXRouter heartbeat", () => {
  let router: SystemXRouter;

  beforeEach(() => {
    router = new SystemXRouter(defaultOptions);
  });

  it("acknowledges heartbeats with timestamp", () => {
    const { transport, connection } = createTestConnection(router);
    registerAddress(router, connection, "alice@example.com");

    router.handleMessage(connection, { type: "HEARTBEAT" });

    const heartbeatAcks = transport.getMessagesOfType("HEARTBEAT_ACK");
    expect(heartbeatAcks).toHaveLength(1);
    expect(typeof heartbeatAcks[0].timestamp).toBe("number");
  });
});

describe("SystemXRouter housekeeping", () => {
  let router: SystemXRouter;

  beforeEach(() => {
    router = new SystemXRouter({
      ...defaultOptions,
      heartbeatTimeoutMs: 1_000,
    });
  });

  it("disconnects connections that miss heartbeats", () => {
    const { transport, connection } = createTestConnection(router);
    registerAddress(router, connection, "stale@example.com");
    connection.lastHeartbeat = Date.now() - 5_000;

    router.pruneStaleConnections(Date.now());

    expect(transport.closed).toEqual({ code: 4000, reason: "timeout" });
  });
});

describe("SystemXRouter call routing", () => {
  let router: SystemXRouter;

  beforeEach(() => {
    router = new SystemXRouter(defaultOptions);
  });

  it("handles dial, answer, messaging, and hangup flow", () => {
    const caller = createTestConnection(router);
    registerAddress(router, caller.connection, "caller@example.com");
    const callee = createTestConnection(router);
    registerAddress(router, callee.connection, "callee@example.com");

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "callee@example.com",
      metadata: { subject: "hello" },
    });

    const ringMessages = callee.transport.getMessagesOfType("RING");
    expect(ringMessages).toHaveLength(1);
    const ring = ringMessages[0];
    expect(ring).toMatchObject({
      type: "RING",
      from: "caller@example.com",
      metadata: { subject: "hello" },
    });
    const callId = ring.call_id;
    expect(typeof callId).toBe("string");

    router.handleMessage(callee.connection, {
      type: "ANSWER",
      call_id: callId,
    });

    const connectedMessages = caller.transport.getMessagesOfType("CONNECTED");
    expect(connectedMessages).toHaveLength(1);
    expect(connectedMessages[0]).toMatchObject({
      type: "CONNECTED",
      call_id: callId,
      to: "callee@example.com",
    });

    router.handleMessage(caller.connection, {
      type: "MSG",
      call_id: callId,
      data: "ping",
      content_type: "text",
    });

    const forwardedMessages = callee.transport.getMessagesOfType("MSG").filter((msg) => msg.call_id === callId);
    expect(forwardedMessages).toHaveLength(1);
    expect(forwardedMessages[0]).toMatchObject({
      type: "MSG",
      call_id: callId,
      data: "ping",
      content_type: "text",
      from: "caller@example.com",
    });

    router.handleMessage(caller.connection, {
      type: "HANGUP",
      call_id: callId,
    });

    const hangupMessages = callee.transport.getMessagesOfType("HANGUP").filter((msg) => msg.call_id === callId);
    expect(hangupMessages).toHaveLength(1);
    expect(hangupMessages[0]).toMatchObject({
      type: "HANGUP",
      call_id: callId,
      reason: "normal",
    });
  });

  it("notifies caller when callee is unavailable", () => {
    const caller = createTestConnection(router);
    registerAddress(router, caller.connection, "caller@example.com");

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "missing@example.com",
    });

    const busyMessages = caller.transport.getMessagesOfType("BUSY");
    expect(busyMessages).toHaveLength(1);
    expect(busyMessages[0]).toMatchObject({
      type: "BUSY",
      to: "missing@example.com",
      reason: "no_such_address",
    });
  });

  it("prevents concurrent calls to the same callee", () => {
    const firstCaller = createTestConnection(router);
    registerAddress(router, firstCaller.connection, "alpha@example.com");
    const callee = createTestConnection(router);
    registerAddress(router, callee.connection, "callee@example.com");
    const secondCaller = createTestConnection(router);
    registerAddress(router, secondCaller.connection, "bravo@example.com");

    router.handleMessage(firstCaller.connection, {
      type: "DIAL",
      to: "callee@example.com",
    });

    router.handleMessage(secondCaller.connection, {
      type: "DIAL",
      to: "callee@example.com",
    });

    const busyMessages = secondCaller.transport.getMessagesOfType("BUSY");
    expect(busyMessages).toHaveLength(1);
    expect(busyMessages[0]).toMatchObject({
      type: "BUSY",
      to: "callee@example.com",
      reason: "already_in_call",
    });
  });

  it("declines calls when callee sets DND status", () => {
    const caller = createTestConnection(router);
    registerAddress(router, caller.connection, "caller@example.com");
    const callee = createTestConnection(router);
    registerAddress(router, callee.connection, "callee@example.com");

    router.handleMessage(callee.connection, {
      type: "STATUS",
      status: "dnd",
    });

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "callee@example.com",
    });

    const busyMessages = caller.transport.getMessagesOfType("BUSY");
    expect(busyMessages).toHaveLength(1);
    expect(busyMessages[0]).toMatchObject({
      type: "BUSY",
      reason: "dnd",
    });
  });

  it("declines calls when callee marks status as away", () => {
    const caller = createTestConnection(router);
    registerAddress(router, caller.connection, "caller@example.com");
    const callee = createTestConnection(router);
    registerAddress(router, callee.connection, "callee@example.com");

    router.handleMessage(callee.connection, {
      type: "STATUS",
      status: "away",
    });

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "callee@example.com",
    });

    const busyMessages = caller.transport.getMessagesOfType("BUSY");
    expect(busyMessages).toHaveLength(1);
    expect(busyMessages[0]).toMatchObject({
      type: "BUSY",
      reason: "away",
    });
  });

  it("honours manual busy status", () => {
    const caller = createTestConnection(router);
    registerAddress(router, caller.connection, "caller@example.com");
    const callee = createTestConnection(router);
    registerAddress(router, callee.connection, "callee@example.com");

    router.handleMessage(callee.connection, {
      type: "STATUS",
      status: "busy",
    });

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "callee@example.com",
    });

    const busyMessages = caller.transport.getMessagesOfType("BUSY");
    expect(busyMessages).toHaveLength(1);
    expect(busyMessages[0]).toMatchObject({
      type: "BUSY",
      reason: "busy",
    });
  });

  it("times out unanswered calls", async () => {
    router = new SystemXRouter({
      ...defaultOptions,
      callRingingTimeoutMs: 50,
    });
    const caller = createTestConnection(router);
    registerAddress(router, caller.connection, "caller@example.com");
    const callee = createTestConnection(router);
    registerAddress(router, callee.connection, "callee@example.com");

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "callee@example.com",
    });

    await Bun.sleep(80);

    const busyMessages = caller.transport.getMessagesOfType("BUSY");
    expect(busyMessages).toHaveLength(1);
    expect(busyMessages[0]).toMatchObject({
      type: "BUSY",
      reason: "timeout",
    });

    const hangups = callee.transport.getMessagesOfType("HANGUP");
    expect(hangups).toHaveLength(1);
    expect(hangups[0]).toMatchObject({
      type: "HANGUP",
      reason: "timeout",
    });

    expect(caller.connection.activeCallId).toBeUndefined();
    expect(callee.connection.activeCallId).toBeUndefined();
    expect(callee.connection.status).toBe("available");
  });
});

describe("SystemXRouter validation", () => {
  let router: SystemXRouter;

  beforeEach(() => {
    router = new SystemXRouter(defaultOptions);
  });

  it("responds with error when dial payload is missing 'to'", () => {
    const { transport, connection } = createTestConnection(router);
    registerAddress(router, connection, "alice@example.com");

    router.handleMessage(connection, { type: "DIAL" } as any);

    const errors = transport.getMessagesOfType("ERROR");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "ERROR",
      reason: "invalid_payload",
    });
  });

  it("rejects invalid status values", () => {
    const { transport, connection } = createTestConnection(router);
    registerAddress(router, connection, "alice@example.com");

    router.handleMessage(connection, { type: "STATUS", status: "napping" as any });

    const errors = transport.getMessagesOfType("ERROR");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "ERROR",
      reason: "invalid_payload",
    });
  });

  it("rejects unsupported MSG content types", () => {
    const caller = createTestConnection(router);
    registerAddress(router, caller.connection, "caller@example.com");
    const callee = createTestConnection(router);
    registerAddress(router, callee.connection, "callee@example.com");

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "callee@example.com",
    });
    const ring = callee.transport.getMessagesOfType("RING")[0];
    const callId = ring.call_id as string;

    router.handleMessage(callee.connection, {
      type: "ANSWER",
      call_id: callId,
    });

    router.handleMessage(caller.connection, {
      type: "MSG",
      call_id: callId,
      data: "payload",
      content_type: "xml" as any,
    });

    const errors = caller.transport.getMessagesOfType("ERROR");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "ERROR",
      context: "MSG",
      reason: "invalid_payload",
    });
  });
});
