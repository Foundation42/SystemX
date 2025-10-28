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
  ConcurrencyMode,
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

type BroadcastSession = {
  callId: string;
  broadcaster: ConnectionContext;
  listeners: Map<string, ConnectionContext>;
  active: boolean;
  metadata?: Record<string, unknown>;
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
  private readonly broadcastSessionsByAddress = new Map<string, BroadcastSession>();
  private readonly broadcastSessionsByCallId = new Map<string, BroadcastSession>();

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

    const concurrency = this.normalizeConcurrency(message.concurrency);
    if (!concurrency) {
      this.sendInvalidPayload(connection, "REGISTER", `Unsupported concurrency mode: ${String(message.concurrency)}`);
      return;
    }

    const maxListeners = this.extractPositiveInteger(message.max_listeners);
    if (maxListeners === null) {
      this.sendInvalidPayload(connection, "REGISTER", "max_listeners must be a positive integer");
      return;
    }
    const maxSessions = this.extractPositiveInteger(message.max_sessions);
    if (maxSessions === null) {
      this.sendInvalidPayload(connection, "REGISTER", "max_sessions must be a positive integer");
      return;
    }
    const poolSize = this.extractPositiveInteger(message.pool_size);
    if (poolSize === null) {
      this.sendInvalidPayload(connection, "REGISTER", "pool_size must be a positive integer");
      return;
    }
    if (concurrency !== "broadcast" && maxListeners !== undefined) {
      this.sendInvalidPayload(connection, "REGISTER", "max_listeners is only valid for broadcast concurrency");
      return;
    }
    if (concurrency !== "parallel" && maxSessions !== undefined) {
      this.sendInvalidPayload(connection, "REGISTER", "max_sessions is only valid for parallel concurrency");
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

    connection.concurrency = concurrency;
    connection.maxListeners = concurrency === "broadcast" ? maxListeners : undefined;
    connection.maxSessions = concurrency === "parallel" ? maxSessions : undefined;
    connection.poolSize = poolSize;
    connection.activeCallIds.clear();

    if (connection.address) {
      const existingBroadcastSession = this.broadcastSessionsByAddress.get(connection.address);
      if (existingBroadcastSession) {
        if (concurrency !== "broadcast") {
          this.terminateBroadcastSession(existingBroadcastSession, "reconfigured");
        } else {
          existingBroadcastSession.broadcaster = connection;
        }
      }
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
      this.resetSleepTimer(connection);
    } else {
      this.clearSleepTimer(connection);
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
    this.resetSleepTimer(connection);
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
    if (callee.status === "busy" && callee.activeCallIds.size === 0) {
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

    switch (callee.concurrency) {
      case "broadcast":
        this.handleBroadcastDial(caller, callee, message);
        return;
      case "parallel": {
        if (callee.maxSessions !== undefined && callee.activeCallIds.size >= callee.maxSessions) {
          caller.transport.send({
            type: "BUSY",
            to: message.to,
            reason: "max_sessions_reached",
          });
          return;
        }
        break;
      }
      case "single":
      default:
        if (this.hasActiveCall(callee)) {
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
        break;
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
    this.addActiveCall(params.caller, call.callId);
    params.caller.status = "busy";
    this.addActiveCall(params.callee, call.callId);
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
      const broadcastSession = this.broadcastSessionsByCallId.get(message.call_id);
      if (broadcastSession && broadcastSession.broadcaster === connection) {
        broadcastSession.active = true;
      }
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
      const session = this.broadcastSessionsByCallId.get(message.call_id);
      if (session) {
        const reason = message.reason ?? "normal";
        if (session.broadcaster === connection) {
          this.terminateBroadcastSession(session, reason);
        } else {
          this.removeBroadcastListener(session, connection, reason);
        }
      }
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
      const session = this.broadcastSessionsByCallId.get(message.call_id);
      if (!session) {
        return;
      }
      const payload = {
        type: "MSG",
        call_id: session.callId,
        from: connection.address,
        data: message.data,
        content_type: message.content_type ?? "text",
      } as Record<string, unknown>;
      if (session.broadcaster === connection) {
        for (const [, listener] of session.listeners) {
          listener.transport.send(payload);
        }
        this.logger.debug("Broadcast message sent", {
          callId: session.callId,
          from: connection.address,
          listeners: session.listeners.size,
        });
      } else if (session.listeners.has(connection.sessionId)) {
        session.broadcaster.transport.send(payload);
        this.logger.debug("Broadcast listener message", {
          callId: session.callId,
          from: connection.address,
          broadcaster: session.broadcaster.address,
        });
      }
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
      if (handler.payload && typeof handler.payload !== "object") {
        this.sendInvalidPayload(connection, "REGISTER", "wake_handler.payload must be an object");
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
    this.addActiveCall(caller, callId);
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

  private getOrCreateBroadcastSession(broadcaster: ConnectionContext): BroadcastSession | null {
    if (!broadcaster.address) {
      return null;
    }
    let session = this.broadcastSessionsByAddress.get(broadcaster.address);
    if (session) {
      session.broadcaster = broadcaster;
      return session;
    }
    const callId = randomUUID();
    session = {
      callId,
      broadcaster,
      listeners: new Map(),
      active: true,
    };
    this.broadcastSessionsByAddress.set(broadcaster.address, session);
    this.broadcastSessionsByCallId.set(callId, session);
    this.addActiveCall(broadcaster, callId);
    broadcaster.status = "busy";
    return session;
  }

  private handleBroadcastDial(caller: ConnectionContext, callee: ConnectionContext, message: DialMessage) {
    const session = this.getOrCreateBroadcastSession(callee);
    if (!session) {
      return;
    }
    if (callee.maxListeners !== undefined && session.listeners.size >= callee.maxListeners) {
      caller.transport.send({
        type: "BUSY",
        to: callee.address,
        reason: "max_listeners_reached",
      });
      return;
    }
    if (session.listeners.has(caller.sessionId)) {
      caller.transport.send({
        type: "CONNECTED",
        call_id: session.callId,
        to: callee.address,
      });
      return;
    }

    session.listeners.set(caller.sessionId, caller);
    this.addActiveCall(caller, session.callId);
    caller.status = "busy";

    caller.transport.send({
      type: "CONNECTED",
      call_id: session.callId,
      to: callee.address,
    });

    this.resetSleepTimer(caller);
    this.resetSleepTimer(callee);

    if (callee.address && caller.address) {
      callee.transport.send({
        type: "RING",
        from: caller.address,
        call_id: session.callId,
        metadata: message.metadata,
      });
    }

    this.logger.info("Broadcast listener connected", {
      broadcaster: callee.address,
      listener: caller.address,
      callId: session.callId,
      listeners: session.listeners.size,
    });
  }

  private removeBroadcastListener(session: BroadcastSession, listener: ConnectionContext, reason: string) {
    if (!session.listeners.delete(listener.sessionId)) {
      return;
    }
    this.removeActiveCall(listener, session.callId);
    if (!this.hasActiveCall(listener)) {
      listener.status = "available";
    }
    listener.transport.send({
      type: "HANGUP",
      call_id: session.callId,
      reason,
    });
    if (listener.address && session.broadcaster.address) {
      session.broadcaster.transport.send({
        type: "HANGUP",
        call_id: session.callId,
        from: listener.address,
        reason,
      });
    }
    if (session.listeners.size === 0) {
      this.terminateBroadcastSession(session, reason);
    }
  }

  private terminateBroadcastSession(session: BroadcastSession, reason: string) {
    if (session.broadcaster.address) {
      this.broadcastSessionsByAddress.delete(session.broadcaster.address);
    }
    this.broadcastSessionsByCallId.delete(session.callId);
    for (const [, listener] of session.listeners) {
      this.removeActiveCall(listener, session.callId);
      listener.transport.send({
        type: "HANGUP",
        call_id: session.callId,
        reason,
      });
      if (!this.hasActiveCall(listener)) {
        listener.status = "available";
      }
    }
    session.listeners.clear();
    this.removeActiveCall(session.broadcaster, session.callId);
    if (!this.hasActiveCall(session.broadcaster)) {
      session.broadcaster.status = "available";
    }
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
    if (pending.caller.activeCallIds.has(callId)) {
      this.removeActiveCall(pending.caller, callId);
      if (!this.hasActiveCall(pending.caller)) {
        pending.caller.status = "available";
      }
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

  private addActiveCall(connection: ConnectionContext, callId: string) {
    connection.activeCallIds.add(callId);
  }

  private removeActiveCall(connection: ConnectionContext, callId: string) {
    connection.activeCallIds.delete(callId);
  }

  private hasActiveCall(connection: ConnectionContext): boolean {
    return connection.activeCallIds.size > 0;
  }

  private normalizeConcurrency(mode?: string | ConcurrencyMode): ConcurrencyMode | null {
    if (!mode) {
      return "single";
    }
    if (mode === "single" || mode === "broadcast" || mode === "parallel") {
      return mode;
    }
    return null;
  }

  private extractPositiveInteger(value: unknown): number | undefined | null {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Math.floor(value);
  }

  private resetSleepTimer(connection: ConnectionContext) {
    this.clearSleepTimer(connection);
    if (!connection.autoSleep || !connection.autoSleep.wakeOnRing) {
      return;
    }
    const timeoutMs = Math.max(connection.autoSleep.idleTimeoutSeconds * 1000, 100);
    connection.sleepTimer = setTimeout(() => {
      this.handleSleepTimer(connection);
    }, timeoutMs);
  }

  private clearSleepTimer(connection: ConnectionContext) {
    if (connection.sleepTimer) {
      clearTimeout(connection.sleepTimer);
      connection.sleepTimer = undefined;
    }
  }

  private handleSleepTimer(connection: ConnectionContext) {
    connection.sleepTimer = undefined;
    if (connection.autoSleep?.wakeOnRing !== true) {
      return;
    }
    if (!connection.address) {
      return;
    }
    if (this.hasActiveCall(connection)) {
      this.resetSleepTimer(connection);
      return;
    }
    const warningMs = Math.max(200, Math.min(connection.autoSleep.idleTimeoutSeconds * 1000, 5_000));
    connection.transport.send({
      type: "SLEEP_PENDING",
      reason: "idle_timeout",
      seconds_until_sleep: Math.floor(warningMs / 1000),
    });
    connection.sleepTimer = setTimeout(() => {
      connection.sleepTimer = undefined;
      this.logger.info("Auto-sleeping connection", {
        address: connection.address,
        sessionId: connection.sessionId,
      });
      this.storeWakeProfile(connection);
      this.disconnect(connection, "sleep");
    }, warningMs);
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
    if (call.caller.activeCallIds.has(call.callId)) {
      this.removeActiveCall(call.caller, call.callId);
      if (!this.hasActiveCall(call.caller)) {
        call.caller.status = "available";
      }
      this.resetSleepTimer(call.caller);
    }
    if (call.callee.activeCallIds.has(call.callId)) {
      this.removeActiveCall(call.callee, call.callId);
      if (!this.hasActiveCall(call.callee)) {
        call.callee.status = "available";
      }
      this.resetSleepTimer(call.callee);
    }
    if (call.callee.address) {
      this.resumePendingWakeCalls(call.callee);
    }
    this.calls.release(call.callId);
  }

  disconnect(connection: ConnectionContext, reason: string) {
    this.clearSleepTimer(connection);
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
    const activeCallIds = Array.from(connection.activeCallIds);
    for (const callId of activeCallIds) {
      const call = this.calls.getCall(callId);
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
        continue;
      }
      const broadcastSession = this.broadcastSessionsByCallId.get(callId);
      if (broadcastSession) {
        if (broadcastSession.broadcaster === connection) {
          this.terminateBroadcastSession(broadcastSession, reason);
        } else {
          this.removeBroadcastListener(broadcastSession, connection, reason);
        }
      }
    }
    this.cancelPendingWakeCallsForCaller(connection, reason);
    connection.transport.close?.(4000, reason);
  }
}
