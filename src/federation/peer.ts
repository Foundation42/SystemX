import { Buffer } from "node:buffer";
import { randomUUID } from "crypto";
import { setInterval as setNodeInterval, clearInterval as clearNodeInterval, setTimeout as setNodeTimeout } from "node:timers";
import type { SystemXRouter } from "../router";
import type { Logger } from "../logger";
import type { ConnectionContext, MessageTransport } from "../connection";
import type { RouterInboundMessage } from "../types";
import { createFederationWebSocketTransport, FederationWebSocketTransport } from "./websocket";

const HEARTBEAT_DEFAULT_MS = 30_000;
const RECONNECT_DEFAULT_DELAY_MS = 5_000;

export type FederationPeerTransportKind = "websocket";

export interface FederationPeerConfig {
  id?: string;
  url: string;
  routes: string[];
  auth?: string;
  transport?: FederationPeerTransportKind;
  reconnectDelayMs?: number;
  announceRoutes?: string[];
  protocols?: string | string[];
}

export interface FederationEnvironment {
  router: SystemXRouter;
  logger: Logger;
  localDomain: string;
  announceRoutes: string[];
  heartbeatIntervalMs?: number;
}

type PendingReconnect = ReturnType<typeof setNodeTimeout> | null;

export class FederationPeer {
  private connection: ConnectionContext | null = null;
  private readonly transport: FederationWebSocketTransport;
  private readonly logger: Logger;
  private readonly router: SystemXRouter;
  private readonly config: FederationPeerConfig;
  private readonly localDomain: string;
  private readonly announceRoutes: string[];
  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: ReturnType<typeof setNodeInterval> | null = null;
  private reconnectTimer: PendingReconnect = null;
  private shuttingDown = false;
  private readonly peerId: string;

  constructor(config: FederationPeerConfig, env: FederationEnvironment) {
    this.config = config;
    this.logger = env.logger;
    this.router = env.router;
    this.localDomain = env.localDomain;
    this.announceRoutes = config.announceRoutes && config.announceRoutes.length > 0 ? config.announceRoutes : env.announceRoutes;
    this.heartbeatIntervalMs = env.heartbeatIntervalMs ?? HEARTBEAT_DEFAULT_MS;
    this.transport = createFederationWebSocketTransport({
      connectTimeoutMs: 10_000,
      protocols: config.protocols,
    });
    this.peerId = config.id ?? new URL(config.url).host ?? randomUUID();
    this.registerTransportEvents();
  }

  start() {
    this.shuttingDown = false;
    this.connect();
  }

  stop() {
    this.shuttingDown = true;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    if (this.connection) {
      try {
        this.router.disconnect(this.connection, "shutdown");
      } catch (error) {
        this.logger.warn("Failed to disconnect federation connection cleanly", {
          error: (error as Error).message,
          peerId: this.peerId,
        });
      } finally {
        this.connection = null;
      }
    }
    if (this.transport.state !== "closed" && this.transport.state !== "closing") {
      this.transport.close(1000, "shutdown");
    }
  }

  private registerTransportEvents() {
    this.transport.on("open", () => {
      this.logger.info("Federation peer connected", {
        peerId: this.peerId,
        url: this.config.url,
      });
      this.onOpen();
    });
    this.transport.on("message", (data) => {
      this.onMessage(data);
    });
    this.transport.on("close", (code: number, reason?: string) => {
      this.logger.warn("Federation peer connection closed", {
        peerId: this.peerId,
        code,
        reason,
      });
      this.onClose(code, reason);
    });
    this.transport.on("error", (error: Error) => {
      this.logger.error("Federation peer transport error", {
        peerId: this.peerId,
        error: error.message,
      });
    });
  }

  private async connect() {
    try {
      await this.transport.connect({ url: this.config.url, protocols: this.config.protocols });
    } catch (error) {
      this.logger.error("Failed to connect federation peer", {
        peerId: this.peerId,
        url: this.config.url,
        error: (error as Error).message,
      });
      this.scheduleReconnect();
    }
  }

  private onOpen() {
    this.clearReconnectTimer();
    const transport: MessageTransport = {
      send: (message) => {
        const messageType = (message as any)?.type;
        if (messageType === "REGISTERED_PBX") {
          this.logger.debug("Suppressing local REGISTERED_PBX ack for federation transport", {
            peerId: this.peerId,
          });
          return;
        }
        if (messageType === "ERROR") {
          this.logger.debug("Suppressing federation ERROR frame to avoid feedback loop", {
            peerId: this.peerId,
            reason: (message as any)?.reason,
            context: (message as any)?.context,
          });
          return;
        }
        try {
          this.transport.send(message);
        } catch (error) {
          this.logger.error("Failed to send federation message", {
            peerId: this.peerId,
            error: (error as Error).message,
          });
        }
      },
      close: (code?: number, reason?: string) => {
        if (this.transport.state === "open" || this.transport.state === "connecting") {
          this.transport.close(code, reason);
        }
      },
    };

    const connection = this.router.createConnection({
      id: `federation:${this.peerId}`,
      transport,
    });
    this.connection = connection;

    this.router.handleMessage(connection, {
      type: "REGISTER_PBX",
      domain: this.peerId,
      routes: this.config.routes,
      endpoint: this.config.url,
    });

    const registerMessage = {
      type: "REGISTER_PBX",
      domain: this.localDomain,
      routes: this.announceRoutes,
      endpoint: "internal",
      auth: this.config.auth,
    };
    try {
      this.transport.send(registerMessage);
    } catch (error) {
      this.logger.error("Failed to send REGISTER_PBX to federation parent", {
        peerId: this.peerId,
        error: (error as Error).message,
      });
    }

    this.startHeartbeat();
  }

  private onMessage(data: unknown) {
    if (!this.connection) {
      this.logger.warn("Dropping federation message without active connection", {
        peerId: this.peerId,
      });
      return;
    }

    let text: string | null = null;
    if (typeof data === "string") {
      text = data;
    } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
      text = data.toString("utf8");
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString("utf8");
    } else {
      text = data ? String(data) : null;
    }

    if (!text) {
      this.logger.warn("Dropping non-text federation message", {
        peerId: this.peerId,
        dataType: typeof data,
      });
      return;
    }

    let parsed: RouterInboundMessage;
    try {
      parsed = JSON.parse(text) as RouterInboundMessage;
    } catch (error) {
      this.logger.warn("Failed to parse federation message", {
        peerId: this.peerId,
        error: (error as Error).message,
        payload: text.slice(0, 200),
      });
      return;
    }

    const messageType = (parsed as any)?.type;
    this.logger.debug("Federation message received", {
      peerId: this.peerId,
      type: messageType ?? "unknown",
    });

    if (messageType === "REGISTERED_PBX") {
      this.logger.info("Federation parent acknowledged registration", {
        peerId: this.peerId,
        domain: (parsed as any)?.domain,
      });
      return;
    }
    if (messageType === "REGISTER_PBX_FAILED" || messageType === "REGISTER_FAILED") {
      this.logger.error("Federation parent rejected registration", {
        peerId: this.peerId,
        reason: (parsed as any)?.reason ?? "unknown",
      });
      return;
    }
    if (messageType === "HEARTBEAT_ACK") {
      return;
    }

    this.router.handleMessage(this.connection, parsed);
  }

  private onClose(_code: number, reason?: string) {
    this.clearHeartbeat();
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try {
        this.router.disconnect(connection, reason ?? "peer_disconnected");
      } catch (error) {
        this.logger.warn("Error during federation disconnect cleanup", {
          peerId: this.peerId,
          error: (error as Error).message,
        });
      }
    }
    if (!this.shuttingDown) {
      this.scheduleReconnect();
    }
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    if (this.heartbeatIntervalMs <= 0) {
      return;
    }
    this.heartbeatTimer = setNodeInterval(() => {
      try {
        this.transport.send({ type: "HEARTBEAT" });
      } catch (error) {
        this.logger.warn("Failed to send federation heartbeat", {
          peerId: this.peerId,
          error: (error as Error).message,
        });
      }
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearNodeInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.shuttingDown) {
      return;
    }
    this.clearReconnectTimer();
    const delay = this.config.reconnectDelayMs ?? RECONNECT_DEFAULT_DELAY_MS;
    this.reconnectTimer = setNodeTimeout(() => {
      this.connect();
    }, delay);
    this.logger.info("Scheduled federation reconnect", {
      peerId: this.peerId,
      delayMs: delay,
    });
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
