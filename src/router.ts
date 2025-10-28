import { randomUUID } from "crypto";
import {
  AnswerMessage,
  DialMessage,
  HeartbeatMessage,
  HangupMessage,
  MsgMessage,
  PresenceMessage,
  PresenceQuery,
  PresenceStatus,
  RegisterMessage,
  RouterInboundMessage,
  RouterOptions,
  StatusMessage,
  SleepAckMessage,
  WakeMode,
  WakeHandlerConfig,
  UnregisterMessage,
} from "./types";
import { ConnectionContext, ConnectionRegistry, MessageTransport } from "./connection";
import { CallManager, CallState } from "./call";
import { ConsoleLogger, Logger } from "./logger";
import { isValidAddress } from "./utils";
import { NoopWakeExecutor, WakeExecutor, WakeProfile } from "./wake";

const VALID_STATUSES = new Set<PresenceStatus>(["available", "busy", "dnd", "away"]);

type PendingWakeCall = {
  callId: string;
  caller: ConnectionContext;
  calleeAddress: string;
  metadata?: Record<string, unknown>;
  wakeProfile: WakeProfile;
  timer: ReturnType<typeof setTimeout>;
};

export class SystemXRouter {
  private readonly connections = new ConnectionRegistry();
  private readonly calls = new CallManager();
  private readonly logger: Logger;
  private readonly callTimeoutMs: number;
  private readonly callTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dialMaxAttempts: number;
  private readonly dialWindowMs: number;
  private readonly dialCounters = new Map<string, { count: number; windowStart: number }>();
  private readonly wakeExecutor: WakeExecutor;
  private readonly wakeProfiles = new Map<string, WakeProfile>();
  private readonly pendingWakeCallsByAddress = new Map<string, PendingWakeCall[]>();
  private readonly pendingWakeCallsById = new Map<string, PendingWakeCall>();

  constructor(private readonly options: RouterOptions) {
    if (!options) {
      throw new Error("Router options required");
    }
    this.logger = options.logger ?? new ConsoleLogger();
    this.callTimeoutMs = options.callRingingTimeoutMs ?? 30_000;
    this.dialMaxAttempts = options.dialRateLimit?.maxAttempts ?? 100;
    this.dialWindowMs = options.dialRateLimit?.windowMs ?? 60_000;
    this.wakeExecutor = options.wakeExecutor ?? new NoopWakeExecutor(this.logger);
  }

  createConnection(params: { id: string; transport: MessageTransport }): ConnectionContext {
    return this.connections.createConnection({ id: params.id, transport: params.transport });
  }

  handleMessage(connection: ConnectionContext, message: RouterInboundMessage) {
    switch (message.type) {
      case "REGISTER":
        this.handleRegister(connection, message);
        break;
      case "STATUS":
        this.handleStatus(connection, message);
        break;
      case "UNREGISTER":
        this.handleUnregister(connection, message);
        break;
      case "HEARTBEAT":
        this.handleHeartbeat(connection, message);
        break;
      case "DIAL":
        this.handleDial(connection, message);
        break;
      case "ANSWER":
        this.handleAnswer(connection, message);
        break;
      case "HANGUP":
        this.handleHangup(connection, message);
        break;
      case "MSG":
        this.handleMsg(connection, message);
        break;
      case "PRESENCE":
        this.handlePresence(connection, message);
        break;
      case "SLEEP_ACK":
        this.handleSleepAck(connection, message);
        break;
      default:
        this.sendInvalidPayload(connection, "UNKNOWN", `Unsupported message type: ${String((message as any).type)}`);
        break;
    }
  }

  pruneStaleConnections(now: number = Date.now()) {
    for (const connection of this.connections.getAllConnections()) {
      if (now - connection.lastHeartbeat > this.options.heartbeatTimeoutMs) {
        this.logger.warn("Disconnecting stale connection", {
          address: connection.address,
          sessionId: connection.sessionId,
        });
        this.disconnect(connection, "timeout");
      }
    }
  }

  private handleRegister(connection: ConnectionContext, message: RegisterMessage) {
    if (typeof message.address !== "string") {
      this.sendInvalidPayload(connection, "REGISTER", "Field 'address' must be a string");
      return;
    }
    if (!isValidAddress(message.address)) {
      this.logger.warn("Registration failed: invalid address", {
        attemptedAddress: message.address,
      });
      connection.transport.send({
        type: "REGISTER_FAILED",
        reason: "invalid_address",
      });
      return;
    }

    let wakeMode: WakeMode | undefined;
    let wakeHandler = connection.wakeHandler;
    if (message.mode) {
      if (message.mode !== "wake_on_ring") {
        this.sendInvalidPayload(connection, "REGISTER", `Unsupported mode: ${message.mode}`);
        return;
      }
      wakeMode = message.mode;
      wakeHandler = this.validateWakeHandler(connection, message.wake_handler);
      if (!wakeHandler) {
        return;
      }
    } else if (message.wake_handler) {
      this.sendInvalidPayload(connection, "REGISTER", "wake_handler requires mode 'wake_on_ring'");
      return;
    }

    const storedProfile = this.wakeProfiles.get(message.address);
    if (!wakeHandler && storedProfile) {
      wakeMode = "wake_on_ring";
      wakeHandler = storedProfile.handler;
      this.wakeProfiles.delete(message.address);
    }

    const result = this.connections.registerAddress(connection, message.address, message.metadata);
    if (!result.success) {
      this.logger.warn("Registration failed: address in use", {
        address: message.address,
        sessionId: connection.sessionId,
      });
      connection.transport.send({
        type: "REGISTER_FAILED",
        reason: result.reason,
      });
      return;
    }

    if (wakeMode === "wake_on_ring" && wakeHandler) {
      connection.wakeMode = wakeMode;
      connection.wakeHandler = wakeHandler;
    } else {
      connection.wakeMode = undefined;
      connection.wakeHandler = undefined;
    }

    connection.transport.send({
      type: "REGISTERED",
      address: message.address,
      session_id: connection.sessionId,
    });
    this.logger.info("Connection registered", {
      address: message.address,
      sessionId: connection.sessionId,
    });

    if (wakeMode === "wake_on_ring") {
      this.logger.debug("Wake-on-ring profile active", {
        address: message.address,
        handlerType: wakeHandler?.type,
      });
    }

    if (connection.address) {
      this.resumePendingWakeCalls(connection);
    }
  }

  private handleStatus(connection: ConnectionContext, message: StatusMessage) {
    if (typeof message.status !== "string" || !VALID_STATUSES.has(message.status)) {
      this.sendInvalidPayload(connection, "STATUS", `Invalid status value: ${String(message.status)}`);
      return;
    }
    this.connections.setStatus(connection, message.status);
    this.logger.debug("Status updated", {
      address: connection.address,
      status: message.status,
    });
    if (message.auto_sleep) {
      if (
        typeof message.auto_sleep.idle_timeout_seconds !== "number" ||
        message.auto_sleep.idle_timeout_seconds < 0 ||
        typeof message.auto_sleep.wake_on_ring !== "boolean"
      ) {
        this.sendInvalidPayload(connection, "STATUS", "Invalid auto_sleep payload");
        return;
      }
      connection.autoSleep = {
        idleTimeoutSeconds: message.auto_sleep.idle_timeout_seconds,
        wakeOnRing: message.auto_sleep.wake_on_ring,
      };
    }
  }

  private handleUnregister(connection: ConnectionContext, _message: UnregisterMessage) {
    if (connection.wakeMode === "wake_on_ring" && connection.wakeHandler && connection.address) {
      this.storeWakeProfile(connection);
    }
    this.disconnect(connection, "client_requested");
  }

  private handleHeartbeat(connection: ConnectionContext, _message: HeartbeatMessage) {
    this.connections.updateHeartbeat(connection);
    this.logger.debug("Heartbeat received", {
      address: connection.address,
      sessionId: connection.sessionId,
    });
    connection.transport.send({
      type: "HEARTBEAT_ACK",
      timestamp: connection.lastHeartbeat,
    });
  }

  private handleDial(connection: ConnectionContext, message: DialMessage) {
    if (typeof message.to !== "string" || message.to.length === 0) {
      this.sendInvalidPayload(connection, "DIAL", "Field 'to' is required");
      return;
    }
    if (this.isDialRateLimited(connection)) {
      return;
    }
    const caller = connection;
    if (!caller.address) {
      return;
    }
    const callee = this.connections.getByAddress(message.to);
    if (!callee) {
      if (this.tryWakeSleepingAgent(caller, message)) {
        return;
      }
      this.logger.info("Dial failed: no such address", {
        from: caller.address,
        to: message.to,
      });
      caller.transport.send({
        type: "BUSY",
        to: message.to,
        reason: "no_such_address",
      });
      return;
    }
    if (callee === caller) {
      this.logger.warn("Dial failed: caller attempted self-call", {
        address: caller.address,
      });
      caller.transport.send({
        type: "BUSY",
        to: message.to,
        reason: "already_in_call",
      });
      return;
    }
    if (callee.activeCallId) {
      this.logger.info("Dial failed: callee already in call", {
        from: caller.address,
        to: message.to,
      });
      caller.transport.send({
        type: "BUSY",
        to: message.to,
        reason: "already_in_call",
      });
      return;
    }
    if (callee.status === "dnd") {
      this.logger.info("Dial failed: callee in DND", {
        from: caller.address,
        to: message.to,
      });
      caller.transport.send({
        type: "BUSY",
        to: message.to,
        reason: "dnd",
      });
      return;
    }
    if (callee.status === "away") {
      this.logger.info("Dial failed: callee away", {
        from: caller.address,
        to: message.to,
      });
      caller.transport.send({
        type: "BUSY",
        to: message.to,
        reason: "away",
      });
      return;
    }
    if (callee.status === "busy" && !callee.activeCallId) {
      this.logger.info("Dial failed: callee set busy", {
        from: caller.address,
        to: message.to,
      });
      caller.transport.send({
        type: "BUSY",
        to: message.to,
        reason: "busy",
      });
      return;
    }

    this.startCall({ caller, callee, metadata: message.metadata });
  }

  private startCall(params: {
    caller: ConnectionContext;
    callee: ConnectionContext;
    metadata?: Record<string, unknown>;
    callId?: string;
  }) {
    const call = this.calls.createCall({
      caller: params.caller,
      callee: params.callee,
      metadata: params.metadata,
      callId: params.callId,
    });
    params.caller.activeCallId = call.callId;
    params.caller.status = "busy";
    params.callee.activeCallId = call.callId;
    params.callee.status = "busy";
    this.logger.info("Call initiated", {
      callId: call.callId,
      from: params.caller.address,
      to: params.callee.address,
    });
    this.scheduleCallTimeout(call.callId);

    params.callee.transport.send({
      type: "RING",
      from: params.caller.address,
      call_id: call.callId,
      metadata: params.metadata,
    });

    return call;
  }

  private handleAnswer(connection: ConnectionContext, message: AnswerMessage) {
    if (typeof message.call_id !== "string" || message.call_id.length === 0) {
      this.sendInvalidPayload(connection, "ANSWER", "Field 'call_id' is required");
      return;
    }
    const call = this.calls.getCall(message.call_id);
    if (!call) {
      return;
    }
    if (call.callee !== connection) {
      return;
    }
    this.calls.setConnected(call.callId);
    this.clearCallTimer(call.callId);
    call.caller.transport.send({
      type: "CONNECTED",
      call_id: call.callId,
      to: call.callee.address,
    });
    this.logger.info("Call connected", {
      callId: call.callId,
      caller: call.caller.address,
      callee: call.callee.address,
    });
  }

  private handleHangup(connection: ConnectionContext, message: HangupMessage) {
    if (typeof message.call_id !== "string" || message.call_id.length === 0) {
      this.sendInvalidPayload(connection, "HANGUP", "Field 'call_id' is required");
      return;
    }
    const call = this.calls.getCall(message.call_id);
    if (!call) {
      return;
    }
    if (call.state === "ended") {
      return;
    }
    if (call.caller !== connection && call.callee !== connection) {
      return;
    }

    const reason = message.reason ?? "normal";
    this.clearCallTimer(call.callId);
    this.calls.endCall(call.callId, reason);
    const otherParty = connection === call.caller ? call.callee : call.caller;
    otherParty.transport.send({
      type: "HANGUP",
      call_id: call.callId,
      reason,
    });
    this.logger.info("Call ended", {
      callId: call.callId,
      initiatedBy: connection.address,
      reason,
    });
    this.clearCallState(call);
  }

  private handleMsg(connection: ConnectionContext, message: MsgMessage) {
    if (typeof message.call_id !== "string" || message.call_id.length === 0) {
      this.sendInvalidPayload(connection, "MSG", "Field 'call_id' is required");
      return;
    }
    if (
      message.content_type !== undefined &&
      message.content_type !== "text" &&
      message.content_type !== "json" &&
      message.content_type !== "binary"
    ) {
      this.sendInvalidPayload(connection, "MSG", `Unsupported content_type: ${String(message.content_type)}`);
      return;
    }
    const call = this.calls.getCall(message.call_id);
    if (!call || call.state !== "connected") {
      return;
    }
    if (call.caller !== connection && call.callee !== connection) {
      return;
    }
    const otherParty = connection === call.caller ? call.callee : call.caller;
    otherParty.transport.send({
      type: "MSG",
      call_id: call.callId,
      from: connection.address,
      data: message.data,
      content_type: message.content_type ?? "text",
    });
    this.logger.debug("Message forwarded", {
      callId: call.callId,
      from: connection.address,
      to: otherParty.address,
    });
  }

  private handlePresence(connection: ConnectionContext, message: PresenceMessage) {
    if (!connection.address) {
      this.sendError(connection, "not_registered", "PRESENCE", "Registration is required before requesting presence");
      return;
    }

    const query = message.query ?? {};
    if (query.domain !== undefined && typeof query.domain !== "string") {
      this.sendInvalidPayload(connection, "PRESENCE", "Field 'domain' must be a string");
      return;
    }
    if (query.capabilities !== undefined) {
      if (!Array.isArray(query.capabilities)) {
        this.sendInvalidPayload(connection, "PRESENCE", "Field 'capabilities' must be an array");
        return;
      }
      if (query.capabilities.some((cap) => typeof cap !== "string")) {
        this.sendInvalidPayload(connection, "PRESENCE", "Capabilities must be strings");
        return;
      }
    }
    if (query.near) {
      const { lat, lon, radius_km } = query.near;
      if (
        typeof lat !== "number" ||
        typeof lon !== "number" ||
        typeof radius_km !== "number" ||
        radius_km < 0
      ) {
        this.sendInvalidPayload(connection, "PRESENCE", "Invalid near filter");
        return;
      }
    }

    const results: Array<{ address: string; status: PresenceStatus; metadata: Record<string, unknown> }> = [];
    for (const other of this.connections.getAllConnections()) {
      if (!other.address) {
        continue;
      }
      if (other === connection) {
        continue;
      }
      if (!this.matchesPresenceQuery(other, query)) {
        continue;
      }
      results.push({
        address: other.address,
        status: other.status,
        metadata: (other.metadata as Record<string, unknown>) ?? {},
      });
    }

    connection.transport.send({
      type: "PRESENCE_RESULT",
      addresses: results,
    });
  }

  private handleSleepAck(connection: ConnectionContext, _message: SleepAckMessage) {
    if (!connection.address) {
      this.sendInvalidPayload(connection, "SLEEP_ACK", "Registration required before sleeping");
      return;
    }
    if (connection.wakeMode !== "wake_on_ring" || !connection.wakeHandler) {
      this.sendInvalidPayload(connection, "SLEEP_ACK", "Wake-on-ring mode must be configured before sleeping");
      return;
    }
    this.storeWakeProfile(connection);
    this.disconnect(connection, "sleep");
  }

  private matchesPresenceQuery(connection: ConnectionContext, query: PresenceQuery): boolean {
    if (!connection.address) {
      return false;
    }
    if (query.domain) {
      const domainPart = connection.address.split("@")[1];
      if (!domainPart || domainPart.toLowerCase() !== query.domain.toLowerCase()) {
        return false;
      }
    }
    if (query.capabilities) {
      const candidateCaps = Array.isArray((connection.metadata as any)?.capabilities)
        ? ((connection.metadata as any).capabilities as unknown[])
        : [];
      const stringCaps = candidateCaps.filter((item): item is string => typeof item === "string");
      for (const required of query.capabilities) {
        if (!stringCaps.includes(required)) {
          return false;
        }
      }
    }
    if (query.near) {
      const location = this.extractLocation(connection.metadata);
      if (!location) {
        return false;
      }
      const distance = this.haversineDistanceKm(query.near.lat, query.near.lon, location.lat, location.lon);
      if (distance > query.near.radius_km) {
        return false;
      }
    }
    return true;
  }

  private extractLocation(metadata: Record<string, unknown> | undefined): { lat: number; lon: number } | null {
    const location = (metadata as any)?.location;
    if (!location) {
      return null;
    }
    const { lat, lon } = location as { lat?: unknown; lon?: unknown };
    if (typeof lat !== "number" || typeof lon !== "number") {
      return null;
    }
    return { lat, lon };
  }

  private haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const R = 6371; // Earth radius km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private validateWakeHandler(connection: ConnectionContext, handler?: WakeHandlerConfig): WakeHandlerConfig | undefined {
    if (!handler) {
      this.sendInvalidPayload(connection, "REGISTER", "wake_handler is required for wake_on_ring mode");
      return undefined;
    }
    if (typeof handler.timeout_seconds !== "number" || handler.timeout_seconds <= 0) {
      this.sendInvalidPayload(connection, "REGISTER", "wake_handler.timeout_seconds must be positive");
      return undefined;
    }
    if (handler.type === "webhook") {
      if (typeof handler.url !== "string" || handler.url.length === 0) {
        this.sendInvalidPayload(connection, "REGISTER", "wake_handler.url must be a non-empty string");
        return undefined;
      }
    } else if (handler.type === "spawn") {
      if (!Array.isArray(handler.command) || handler.command.length === 0) {
        this.sendInvalidPayload(connection, "REGISTER", "wake_handler.command must be a non-empty array");
        return undefined;
      }
      if (!handler.command.every((part) => typeof part === "string" && part.length > 0)) {
        this.sendInvalidPayload(connection, "REGISTER", "wake_handler.command entries must be non-empty strings");
        return undefined;
      }
    } else {
      this.sendInvalidPayload(connection, "REGISTER", `Unsupported wake handler type: ${String((handler as any).type)}`);
      return undefined;
    }
    return handler;
  }

  private storeWakeProfile(connection: ConnectionContext) {
    if (!connection.address || !connection.wakeHandler) {
      return;
    }
    const profile: WakeProfile = {
      address: connection.address,
      handler: connection.wakeHandler,
    };
    this.wakeProfiles.set(connection.address, profile);
    this.logger.info("Stored wake profile", {
      address: connection.address,
      handlerType: connection.wakeHandler.type,
    });
  }

  private tryWakeSleepingAgent(caller: ConnectionContext, message: DialMessage): boolean {
    const profile = this.wakeProfiles.get(message.to);
    if (!profile) {
      return false;
    }
    const callId = randomUUID();
    const timeoutMs = Math.max(profile.handler.timeout_seconds * 1000, 100);
    const timer = setTimeout(() => {
      this.failPendingWakeCall(callId, "timeout");
    }, timeoutMs);
    const pending: PendingWakeCall = {
      callId,
      caller,
      calleeAddress: message.to,
      metadata: message.metadata,
      wakeProfile: profile,
      timer,
    };
    const queue = this.pendingWakeCallsByAddress.get(message.to) ?? [];
    queue.push(pending);
    this.pendingWakeCallsByAddress.set(message.to, queue);
    this.pendingWakeCallsById.set(callId, pending);
    caller.activeCallId = callId;
    caller.status = "busy";
    this.logger.info("Wake-on-ring attempt started", {
      callId,
      caller: caller.address,
      callee: message.to,
      handlerType: profile.handler.type,
      timeoutMs,
    });
    this.wakeExecutor
      .wake(profile)
      .catch((error) => {
        this.logger.warn("Wake executor failed", {
          address: profile.address,
          error: (error as Error).message,
        });
        this.failPendingWakeCall(callId, "wake_failed");
      });
    return true;
  }

  private resumePendingWakeCalls(callee: ConnectionContext) {
    if (!callee.address) {
      return;
    }
    const queue = this.pendingWakeCallsByAddress.get(callee.address);
    if (!queue || queue.length === 0) {
      return;
    }
    const pending = queue.shift()!;
    this.pendingWakeCallsById.delete(pending.callId);
    clearTimeout(pending.timer);
    if (queue.length === 0) {
      this.pendingWakeCallsByAddress.delete(callee.address);
    }
    const callerStillConnected = this.connections.getBySession(pending.caller.sessionId);
    if (!callerStillConnected) {
      this.logger.warn("Caller disconnected before wake completion", {
        callId: pending.callId,
        callee: callee.address,
      });
      this.failPendingWakeCall(pending.callId, "caller_unavailable");
      this.resumePendingWakeCalls(callee);
      return;
    }
    this.startCall({
      caller: pending.caller,
      callee,
      metadata: pending.metadata,
      callId: pending.callId,
    });
  }

  private failPendingWakeCall(callId: string, reason: string) {
    const pending = this.pendingWakeCallsById.get(callId);
    if (!pending) {
      return;
    }
    this.pendingWakeCallsById.delete(callId);
    const queue = this.pendingWakeCallsByAddress.get(pending.calleeAddress);
    if (queue) {
      const index = queue.findIndex((entry) => entry.callId === callId);
      if (index >= 0) {
        queue.splice(index, 1);
      }
      if (queue.length === 0) {
        this.pendingWakeCallsByAddress.delete(pending.calleeAddress);
      }
    }
    clearTimeout(pending.timer);
    if (pending.caller.activeCallId === callId) {
      pending.caller.activeCallId = undefined;
      pending.caller.status = "available";
    }
    this.logger.warn("Pending wake call failed", {
      callId,
      caller: pending.caller.address,
      callee: pending.calleeAddress,
      reason,
    });
    pending.caller.transport.send({
      type: "BUSY",
      to: pending.calleeAddress,
      reason,
    });
  }

  private cancelPendingWakeCallsForCaller(connection: ConnectionContext, reason: string) {
    const pendingIds = Array.from(this.pendingWakeCallsById.values())
      .filter((pending) => pending.caller === connection)
      .map((pending) => pending.callId);
    for (const callId of pendingIds) {
      this.failPendingWakeCall(callId, reason);
    }
  }

  private sendInvalidPayload(connection: ConnectionContext, context: string, detail: string) {
    this.logger.warn("Invalid message payload", {
      context,
      detail,
      address: connection.address,
      sessionId: connection.sessionId,
    });
    connection.transport.send({
      type: "ERROR",
      reason: "invalid_payload",
      context,
      detail,
    });
  }

  private sendError(connection: ConnectionContext, reason: string, context: string, detail: string) {
    this.logger.warn("Request rejected", {
      reason,
      context,
      detail,
      address: connection.address,
      sessionId: connection.sessionId,
    });
    connection.transport.send({
      type: "ERROR",
      reason,
      context,
      detail,
    });
  }

  private isDialRateLimited(connection: ConnectionContext): boolean {
    if (this.dialMaxAttempts <= 0) {
      return false;
    }
    const now = Date.now();
    const entry = this.dialCounters.get(connection.sessionId);
    if (!entry) {
      this.dialCounters.set(connection.sessionId, { count: 1, windowStart: now });
      return false;
    }
    if (now - entry.windowStart > this.dialWindowMs) {
      entry.count = 1;
      entry.windowStart = now;
      return false;
    }
    entry.count += 1;
    if (entry.count > this.dialMaxAttempts) {
      this.logger.warn("Dial rate limit exceeded", {
        address: connection.address,
        sessionId: connection.sessionId,
        count: entry.count,
        windowMs: this.dialWindowMs,
      });
      connection.transport.send({
        type: "ERROR",
        reason: "rate_limited",
        context: "DIAL",
        detail: "Too many dial attempts",
      });
      return true;
    }
    return false;
  }

  private scheduleCallTimeout(callId: string) {
    this.clearCallTimer(callId);
    const timer = setTimeout(() => {
      this.handleCallTimeout(callId);
    }, this.callTimeoutMs);
    this.callTimers.set(callId, timer);
  }

  private clearCallTimer(callId: string) {
    const timer = this.callTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.callTimers.delete(callId);
    }
  }

  private handleCallTimeout(callId: string) {
    const call = this.calls.getCall(callId);
    if (!call || call.state !== "ringing") {
      return;
    }

    this.logger.info("Call timed out waiting for answer", {
      callId,
      from: call.caller.address,
      to: call.callee.address,
    });
    call.caller.transport.send({
      type: "BUSY",
      to: call.callee.address,
      reason: "timeout",
    });
    call.callee.transport.send({
      type: "HANGUP",
      call_id: call.callId,
      reason: "timeout",
    });
    this.clearCallTimer(callId);
    this.calls.endCall(callId, "timeout");
    this.clearCallState(call);
  }

  private clearCallState(call: CallState) {
    this.clearCallTimer(call.callId);
    if (call.caller.activeCallId === call.callId) {
      call.caller.activeCallId = undefined;
      call.caller.status = "available";
    }
    if (call.callee.activeCallId === call.callId) {
      call.callee.activeCallId = undefined;
      call.callee.status = "available";
    }
    if (call.callee.address) {
      this.resumePendingWakeCalls(call.callee);
    }
    this.calls.release(call.callId);
  }

  disconnect(connection: ConnectionContext, reason: string) {
    if (reason === "timeout" && connection.wakeMode === "wake_on_ring" && connection.wakeHandler && connection.address) {
      this.storeWakeProfile(connection);
    }
    this.connections.disconnect(connection);
    this.dialCounters.delete(connection.sessionId);
    this.logger.info("Connection disconnected", {
      address: connection.address,
      sessionId: connection.sessionId,
      reason,
    });
    if (connection.activeCallId) {
      const call = this.calls.getCall(connection.activeCallId);
      if (call) {
        const other = call.caller === connection ? call.callee : call.caller;
        other.transport.send({
          type: "HANGUP",
          call_id: call.callId,
          reason,
        });
        this.clearCallTimer(call.callId);
        this.calls.endCall(call.callId, reason);
        this.clearCallState(call);
      }
    }
    this.cancelPendingWakeCallsForCaller(connection, reason);
    connection.transport.close?.(4000, reason);
  }
}
