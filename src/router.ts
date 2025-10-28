import {
  AnswerMessage,
  DialMessage,
  HeartbeatMessage,
  HangupMessage,
  MsgMessage,
  RegisterMessage,
  RouterInboundMessage,
  RouterOptions,
  StatusMessage,
  UnregisterMessage,
} from "./types";
import { ConnectionContext, ConnectionRegistry, MessageTransport } from "./connection";
import { CallManager, CallState } from "./call";
import { ConsoleLogger, Logger } from "./logger";
import { isValidAddress } from "./utils";

export class SystemXRouter {
  private readonly connections = new ConnectionRegistry();
  private readonly calls = new CallManager();
  private readonly logger: Logger;

  constructor(private readonly options: RouterOptions) {
    if (!options) {
      throw new Error("Router options required");
    }
    this.logger = options.logger ?? new ConsoleLogger();
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
      default:
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

    connection.transport.send({
      type: "REGISTERED",
      address: message.address,
      session_id: connection.sessionId,
    });
    this.logger.info("Connection registered", {
      address: message.address,
      sessionId: connection.sessionId,
    });
  }

  private handleStatus(connection: ConnectionContext, message: StatusMessage) {
    this.connections.setStatus(connection, message.status);
    this.logger.debug("Status updated", {
      address: connection.address,
      status: message.status,
    });
    if (message.auto_sleep) {
      connection.autoSleep = {
        idleTimeoutSeconds: message.auto_sleep.idle_timeout_seconds,
        wakeOnRing: message.auto_sleep.wake_on_ring,
      };
    }
  }

  private handleUnregister(connection: ConnectionContext, _message: UnregisterMessage) {
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
    const caller = connection;
    if (!caller.address) {
      return;
    }
    const callee = this.connections.getByAddress(message.to);
    if (!callee) {
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

    const call = this.calls.createCall({
      caller,
      callee,
      metadata: message.metadata,
    });
    caller.activeCallId = call.callId;
    caller.status = "busy";
    callee.activeCallId = call.callId;
    callee.status = "busy";
    this.logger.info("Call initiated", {
      callId: call.callId,
      from: caller.address,
      to: callee.address,
    });

    callee.transport.send({
      type: "RING",
      from: caller.address,
      call_id: call.callId,
      metadata: message.metadata,
    });
  }

  private handleAnswer(connection: ConnectionContext, message: AnswerMessage) {
    const call = this.calls.getCall(message.call_id);
    if (!call) {
      return;
    }
    if (call.callee !== connection) {
      return;
    }
    this.calls.setConnected(call.callId);
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

  private clearCallState(call: CallState) {
    if (call.caller.activeCallId === call.callId) {
      call.caller.activeCallId = undefined;
      call.caller.status = "available";
    }
    if (call.callee.activeCallId === call.callId) {
      call.callee.activeCallId = undefined;
      call.callee.status = "available";
    }
    this.calls.release(call.callId);
  }

  disconnect(connection: ConnectionContext, reason: string) {
    this.connections.disconnect(connection);
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
        this.calls.endCall(call.callId, reason);
        this.clearCallState(call);
      }
    }
    connection.transport.close?.(4000, reason);
  }
}
