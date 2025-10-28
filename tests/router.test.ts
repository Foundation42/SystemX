import { describe, expect, it, beforeEach } from "bun:test";
import { SystemXRouter } from "../src/router";
import { RouterOptions } from "../src/types";
import type { Logger } from "../src/logger";
import { randomUUID } from "crypto";
import type { WakeExecutor, WakeProfile } from "../src/wake";

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

class FakeWakeExecutor implements WakeExecutor {
  public readonly invocations: WakeProfile[] = [];
  public shouldFail = false;

  async wake(profile: WakeProfile): Promise<void> {
    this.invocations.push(profile);
    if (this.shouldFail) {
      throw new Error("wake failed");
    }
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

function registerAddress(
  router: SystemXRouter,
  connection: ReturnType<typeof createTestConnection>["connection"],
  address: string,
  metadata?: Record<string, unknown>,
) {
  router.handleMessage(connection, {
    type: "REGISTER",
    address,
    metadata,
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

    expect(caller.connection.activeCallIds.size).toBe(0);
    expect(callee.connection.activeCallIds.size).toBe(0);
    expect(callee.connection.status).toBe("available");
  });

  it("supports parallel sessions up to configured limit", () => {
    router = new SystemXRouter(defaultOptions);
    const callee = createTestConnection(router);
    router.handleMessage(callee.connection, {
      type: "REGISTER",
      address: "bot@parallel.test",
      concurrency: "parallel",
      max_sessions: 2,
    });

    const caller1 = createTestConnection(router);
    registerAddress(router, caller1.connection, "caller1@example.com");
    const caller2 = createTestConnection(router);
    registerAddress(router, caller2.connection, "caller2@example.com");
    const caller3 = createTestConnection(router);
    registerAddress(router, caller3.connection, "caller3@example.com");

    router.handleMessage(caller1.connection, {
      type: "DIAL",
      to: "bot@parallel.test",
    });
    const ringMessages1 = callee.transport.getMessagesOfType("RING");
    expect(ringMessages1).toHaveLength(1);
    const callId1 = ringMessages1[0].call_id as string;
    router.handleMessage(callee.connection, { type: "ANSWER", call_id: callId1 });
    callee.transport.sent.length = 0;

    router.handleMessage(caller2.connection, {
      type: "DIAL",
      to: "bot@parallel.test",
    });
    const ringMessages2 = callee.transport.getMessagesOfType("RING");
    expect(ringMessages2).toHaveLength(1);
    const callId2 = ringMessages2[0].call_id as string;
    router.handleMessage(callee.connection, { type: "ANSWER", call_id: callId2 });
    callee.transport.sent.length = 0;

    router.handleMessage(caller3.connection, {
      type: "DIAL",
      to: "bot@parallel.test",
    });
    const busyMessages = caller3.transport.getMessagesOfType("BUSY");
    expect(busyMessages).toHaveLength(1);
    expect(busyMessages[0]).toMatchObject({ reason: "max_sessions_reached" });

    router.handleMessage(caller1.connection, { type: "HANGUP", call_id: callId1 });

    router.handleMessage(caller3.connection, {
      type: "DIAL",
      to: "bot@parallel.test",
    });
    const ringMessages3 = callee.transport.getMessagesOfType("RING");
    expect(ringMessages3).toHaveLength(1);
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

  it("rate limits excessive dial attempts", () => {
    router = new SystemXRouter({
      ...defaultOptions,
      dialRateLimit: {
        maxAttempts: 2,
        windowMs: 1_000,
      },
    });
    const caller = createTestConnection(router);
    registerAddress(router, caller.connection, "caller@example.com");

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "missing@example.com",
    });

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "missing@example.com",
    });

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "missing@example.com",
    });

    const errors = caller.transport.getMessagesOfType("ERROR");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "ERROR",
      reason: "rate_limited",
      context: "DIAL",
    });
  });
});

describe("SystemXRouter presence", () => {
  let router: SystemXRouter;

  beforeEach(() => {
    router = new SystemXRouter(defaultOptions);
  });

  it("returns presence results filtered by domain and capabilities", () => {
    const requester = createTestConnection(router);
    registerAddress(router, requester.connection, "requester@example.com", {
      capabilities: ["chat"],
    });

    const alice = createTestConnection(router);
    registerAddress(router, alice.connection, "alice@example.com", {
      capabilities: ["chat", "code"],
    });
    const bob = createTestConnection(router);
    registerAddress(router, bob.connection, "bob@other.com", {
      capabilities: ["chat"],
    });

    router.handleMessage(requester.connection, {
      type: "PRESENCE",
      query: {
        domain: "example.com",
        capabilities: ["chat"],
      },
    });

    const results = requester.transport.getMessagesOfType("PRESENCE_RESULT");
    expect(results).toHaveLength(1);
    expect(results[0].addresses).toEqual([
      {
        address: "alice@example.com",
        status: "available",
        metadata: { capabilities: ["chat", "code"] },
      },
    ]);
  });

  it("supports proximity filtering using metadata location", () => {
    const requester = createTestConnection(router);
    registerAddress(router, requester.connection, "requester@example.com");

    const near = createTestConnection(router);
    registerAddress(router, near.connection, "near@example.com", {
      location: { lat: 53.7, lon: -1.8 },
    });
    const far = createTestConnection(router);
    registerAddress(router, far.connection, "far@example.com", {
      location: { lat: 40.71, lon: -74.0 },
    });

    router.handleMessage(requester.connection, {
      type: "PRESENCE",
      query: {
        near: { lat: 53.7, lon: -1.8, radius_km: 5 },
      },
    });

    const results = requester.transport.getMessagesOfType("PRESENCE_RESULT");
    expect(results).toHaveLength(1);
    expect(results[0].addresses).toEqual([
      {
        address: "near@example.com",
        status: "available",
        metadata: { location: { lat: 53.7, lon: -1.8 } },
      },
    ]);
  });

  it("rejects presence queries before registration", () => {
    const { transport, connection } = createTestConnection(router);

    router.handleMessage(connection, {
      type: "PRESENCE",
    });

    const errors = transport.getMessagesOfType("ERROR");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "ERROR",
      reason: "not_registered",
      context: "PRESENCE",
    });
  });
});

function registerWakeAgent(
  router: SystemXRouter,
  connection: ReturnType<typeof createTestConnection>["connection"],
  address: string,
  handlerOverrides?: Partial<WakeProfile["handler"]>,
) {
  const handler = {
    type: "webhook" as const,
    url: "https://wake.example.com/agent",
    timeout_seconds: 0.1,
    ...handlerOverrides,
  };
  router.handleMessage(connection, {
    type: "REGISTER",
    address,
    mode: "wake_on_ring",
    wake_handler: handler,
  });
}

describe("SystemXRouter wake-on-ring", () => {
  let wakeExecutor: FakeWakeExecutor;
  let router: SystemXRouter;

  beforeEach(() => {
    wakeExecutor = new FakeWakeExecutor();
    router = new SystemXRouter({
      ...defaultOptions,
      wakeExecutor,
    });
  });

  it("stores wake profile on sleep and resumes call when agent reconnects", async () => {
    const sleeper = createTestConnection(router);
    registerWakeAgent(router, sleeper.connection, "agent@sleep.com");

    router.handleMessage(sleeper.connection, { type: "SLEEP_ACK" });
    expect(sleeper.transport.closed).toEqual({ code: 4000, reason: "sleep" });

    const caller = createTestConnection(router);
    registerAddress(router, caller.connection, "caller@example.com");

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "agent@sleep.com",
      metadata: { subject: "wake test" },
    });

    expect(wakeExecutor.invocations).toHaveLength(1);
    expect(wakeExecutor.invocations[0].address).toBe("agent@sleep.com");

    const woken = createTestConnection(router);
    router.handleMessage(woken.connection, {
      type: "REGISTER",
      address: "agent@sleep.com",
    });

    const ringMessages = woken.transport.getMessagesOfType("RING");
    expect(ringMessages).toHaveLength(1);
    const ring = ringMessages[0];
    const callId = ring.call_id as string;

    router.handleMessage(woken.connection, {
      type: "ANSWER",
      call_id: callId,
    });

    const connected = caller.transport.getMessagesOfType("CONNECTED");
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({ call_id: callId });

    router.handleMessage(caller.connection, {
      type: "HANGUP",
      call_id: callId,
    });
  });

  it("signals busy when wake executor fails", async () => {
    wakeExecutor.shouldFail = true;

    const sleeper = createTestConnection(router);
    registerWakeAgent(router, sleeper.connection, "agent@fail.com");
    router.handleMessage(sleeper.connection, { type: "SLEEP_ACK" });

    const caller = createTestConnection(router);
    registerAddress(router, caller.connection, "caller@example.com");

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "agent@fail.com",
    });

    await Bun.sleep(10);
    const busy = caller.transport.getMessagesOfType("BUSY");
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ reason: "wake_failed" });
  });

  it("times out wake attempts when agent does not reconnect", async () => {
    const sleeper = createTestConnection(router);
    registerWakeAgent(router, sleeper.connection, "agent@timeout.com", { timeout_seconds: 0.05 });
    router.handleMessage(sleeper.connection, { type: "SLEEP_ACK" });

    const caller = createTestConnection(router);
    registerAddress(router, caller.connection, "caller@example.com");

    router.handleMessage(caller.connection, {
      type: "DIAL",
      to: "agent@timeout.com",
    });

    await Bun.sleep(120);

    const busy = caller.transport.getMessagesOfType("BUSY");
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ reason: "timeout" });
    expect(caller.connection.activeCallIds.size).toBe(0);
  });
});

describe("SystemXRouter auto sleep", () => {
  let router: SystemXRouter;

  beforeEach(() => {
    router = new SystemXRouter(defaultOptions);
  });

  it("sends sleep pending and auto sleeps after timeout", async () => {
    const agent = createTestConnection(router);
    registerWakeAgent(router, agent.connection, "agent@auto.com", { timeout_seconds: 0.2 });

    router.handleMessage(agent.connection, {
      type: "STATUS",
      status: "available",
      auto_sleep: {
        idle_timeout_seconds: 0.05,
        wake_on_ring: true,
      },
    });

    await Bun.sleep(120);

    const sleepPending = agent.transport.getMessagesOfType("SLEEP_PENDING");
    expect(sleepPending).toHaveLength(1);
    expect(sleepPending[0]).toMatchObject({
      reason: "idle_timeout",
    });
    await Bun.sleep(400);
    expect(agent.transport.closed).toEqual({ code: 4000, reason: "sleep" });
  });
});

describe("SystemXRouter broadcast routing", () => {
  let router: SystemXRouter;

  beforeEach(() => {
    router = new SystemXRouter(defaultOptions);
  });

  it("shares broadcast messages with multiple listeners", () => {
    const broadcaster = createTestConnection(router);
    router.handleMessage(broadcaster.connection, {
      type: "REGISTER",
      address: "clock@broadcast.test",
      concurrency: "broadcast",
      max_listeners: 2,
    });

    const listener1 = createTestConnection(router);
    registerAddress(router, listener1.connection, "listener1@example.com");
    const listener2 = createTestConnection(router);
    registerAddress(router, listener2.connection, "listener2@example.com");
    const listener3 = createTestConnection(router);
    registerAddress(router, listener3.connection, "listener3@example.com");

    router.handleMessage(listener1.connection, {
      type: "DIAL",
      to: "clock@broadcast.test",
    });
    const connect1 = listener1.transport.getMessagesOfType("CONNECTED");
    expect(connect1).toHaveLength(1);
    const callId = connect1[0].call_id as string;

    router.handleMessage(listener2.connection, {
      type: "DIAL",
      to: "clock@broadcast.test",
    });
    const connect2 = listener2.transport.getMessagesOfType("CONNECTED");
    expect(connect2).toHaveLength(1);
    expect(connect2[0].call_id).toBe(callId);

    router.handleMessage(listener3.connection, {
      type: "DIAL",
      to: "clock@broadcast.test",
    });
    const busy3 = listener3.transport.getMessagesOfType("BUSY");
    expect(busy3).toHaveLength(1);
    expect(busy3[0]).toMatchObject({ reason: "max_listeners_reached" });

    router.handleMessage(broadcaster.connection, {
      type: "MSG",
      call_id: callId,
      data: "The time is now",
      content_type: "text",
    });

    const listener1Msgs = listener1.transport.getMessagesOfType("MSG");
    const listener2Msgs = listener2.transport.getMessagesOfType("MSG");
    expect(listener1Msgs[0]).toMatchObject({ data: "The time is now" });
    expect(listener2Msgs[0]).toMatchObject({ data: "The time is now" });

    router.handleMessage(listener1.connection, {
      type: "HANGUP",
      call_id: callId,
    });

    const broadcasterHangups = broadcaster.transport.getMessagesOfType("HANGUP");
    expect(broadcasterHangups[broadcasterHangups.length - 1]).toMatchObject({ from: "listener1@example.com" });
  });
});
