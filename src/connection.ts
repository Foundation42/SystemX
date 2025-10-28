import { randomUUID } from "crypto";
import { PresenceStatus, RegisterFailureReason, WakeHandlerConfig, WakeMode } from "./types";

export interface MessageTransport {
  send(message: Record<string, unknown>): void;
  close?(code?: number, reason?: string): void;
}

export type ConnectionContext = {
  id: string;
  sessionId: string;
  transport: MessageTransport;
  address?: string;
  status: PresenceStatus;
  metadata?: Record<string, unknown>;
  lastHeartbeat: number;
  activeCallId?: string;
  autoSleep?: {
    idleTimeoutSeconds: number;
    wakeOnRing: boolean;
  };
  wakeMode?: WakeMode;
  wakeHandler?: WakeHandlerConfig;
};

export type RegisterResult =
  | { success: true }
  | { success: false; reason: RegisterFailureReason };

export class ConnectionRegistry {
  private readonly connectionsByAddress = new Map<string, ConnectionContext>();
  private readonly connectionsBySession = new Map<string, ConnectionContext>();

  createConnection(params: { id?: string; transport: MessageTransport }): ConnectionContext {
    const sessionId = params.id ?? randomUUID();
    const connection: ConnectionContext = {
      id: params.id ?? sessionId,
      sessionId,
      transport: params.transport,
      status: "available",
      lastHeartbeat: Date.now(),
    };
    this.connectionsBySession.set(sessionId, connection);
    return connection;
  }

  getBySession(sessionId: string): ConnectionContext | undefined {
    return this.connectionsBySession.get(sessionId);
  }

  getByAddress(address: string): ConnectionContext | undefined {
    return this.connectionsByAddress.get(address);
  }

  getAllConnections(): Iterable<ConnectionContext> {
    return this.connectionsBySession.values();
  }

  registerAddress(connection: ConnectionContext, address: string, metadata?: Record<string, unknown>): RegisterResult {
    const existing = this.connectionsByAddress.get(address);
    if (existing && existing !== connection) {
      return { success: false, reason: "address_in_use" };
    }

    if (connection.address && connection.address !== address) {
      const current = this.connectionsByAddress.get(connection.address);
      if (current === connection) {
        this.connectionsByAddress.delete(connection.address);
      }
    }

    connection.address = address;
    connection.metadata = metadata;
    this.connectionsByAddress.set(address, connection);
    return { success: true };
  }

  updateHeartbeat(connection: ConnectionContext) {
    connection.lastHeartbeat = Date.now();
  }

  setStatus(connection: ConnectionContext, status: PresenceStatus) {
    connection.status = status;
  }

  disconnect(connection: ConnectionContext) {
    if (connection.address) {
      const current = this.connectionsByAddress.get(connection.address);
      if (current === connection) {
        this.connectionsByAddress.delete(connection.address);
      }
    }
    this.connectionsBySession.delete(connection.sessionId);
  }
}
