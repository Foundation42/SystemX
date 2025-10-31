import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { SystemXRouter } from "./router";
import { logger } from "./logger";
import type { RouterInboundMessage } from "./types";
import type { ConnectionContext, MessageTransport } from "./connection";
import type { ServerWebSocket } from "bun";
import { createWakeExecutor } from "./wake";
import { createFederationManager, loadFederationConfig } from "./federation/manager";
import { LogStreamService } from "./logService";

type SocketData = {
  connection: ConnectionContext | null;
};

const port = parseInt(process.env.SYSTEMX_PORT ?? "8080", 10);
const host = process.env.SYSTEMX_HOST ?? "0.0.0.0";
const heartbeatIntervalMs = parseInt(process.env.SYSTEMX_HEARTBEAT_INTERVAL ?? "30000", 10);
const heartbeatTimeoutMs = parseInt(process.env.SYSTEMX_HEARTBEAT_TIMEOUT ?? "60000", 10);
const callTimeoutMs = parseInt(process.env.SYSTEMX_CALL_TIMEOUT ?? "30000", 10);
const dialMaxAttempts = parseInt(process.env.SYSTEMX_DIAL_MAX_ATTEMPTS ?? "10", 10);
const dialWindowMs = parseInt(process.env.SYSTEMX_DIAL_WINDOW_MS ?? "60000", 10);

// TLS configuration
const tlsEnabled = process.env.TLS_ENABLED === "true";
const tlsCertPath = process.env.TLS_CERT_PATH;
const tlsKeyPath = process.env.TLS_KEY_PATH;

const wakeExecutor = createWakeExecutor(logger);

const router = new SystemXRouter({
  heartbeatIntervalMs,
  heartbeatTimeoutMs,
  logger,
  callRingingTimeoutMs: callTimeoutMs,
  dialRateLimit: {
    maxAttempts: dialMaxAttempts,
    windowMs: dialWindowMs,
  },
  wakeExecutor,
});

function createTransport(ws: ServerWebSocket<SocketData>): MessageTransport {
  return {
    send(message) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        logger.error("Failed to send message", {
          error: (error as Error).message,
        });
      }
    },
    close(code, reason) {
      try {
        ws.close(code ?? 1000, reason);
      } catch (error) {
        logger.error("Failed to close socket", {
          error: (error as Error).message,
        });
      }
    },
  };
}

const textDecoder = new TextDecoder();

function toJsonString(message: unknown): string | null {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return textDecoder.decode(message);
  }
  if (ArrayBuffer.isView(message)) {
    const view = message as ArrayBufferView;
    return textDecoder.decode(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }
  return null;
}

// Build server configuration with optional TLS
const serverConfig: Parameters<typeof Bun.serve<SocketData>>[0] = {
  hostname: host,
  port,
  fetch(request, server) {
    if (server.upgrade(request, { data: { connection: null } })) {
      return;
    }
    return new Response("Upgrade Required", { status: 426 });
  },
  websocket: {
    open(ws) {
      const connection = router.createConnection({
        id: randomUUID(),
        transport: createTransport(ws),
      });
      ws.data.connection = connection;
      logger.info("WebSocket connection established", {
        sessionId: connection.sessionId,
        remoteAddress: ws.remoteAddress,
      });
    },
    message(ws, incoming) {
      const raw = toJsonString(incoming);
      if (!raw) {
        ws.close(1003, "Unsupported message type");
        return;
      }

      let parsed: RouterInboundMessage;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        logger.warn("Closing connection: invalid JSON payload", {
          error: (error as Error).message,
        });
        ws.close(1003, "Invalid JSON");
        return;
      }

      if (!ws.data.connection) {
        ws.close(1011, "Connection not initialized");
        return;
      }

      router.handleMessage(ws.data.connection, parsed);
    },
    close(ws, code, reason) {
      const connection = ws.data.connection;
      if (connection) {
        router.disconnect(connection, "peer_disconnected");
      }
      logger.info("WebSocket connection closed", {
        code,
        reason,
        remoteAddress: ws.remoteAddress,
      });
    },
  },
};

// Add TLS configuration if enabled
if (tlsEnabled && tlsCertPath && tlsKeyPath) {
  try {
    logger.info("Loading TLS certificates", { certPath: tlsCertPath, keyPath: tlsKeyPath });

    const cert = readFileSync(tlsCertPath, "utf-8");
    const key = readFileSync(tlsKeyPath, "utf-8");

    logger.info("TLS certificates loaded", {
      certLength: cert.length,
      keyLength: key.length,
      certPreview: cert.substring(0, 50) + "..."
    });

    serverConfig.tls = {
      cert,
      key,
    };

    logger.info("TLS configuration applied to server");
  } catch (error) {
    logger.error("Failed to load TLS certificates", {
      error: (error as Error).message,
      stack: (error as Error).stack,
      certPath: tlsCertPath,
      keyPath: tlsKeyPath
    });
    throw error;
  }
}

const server = Bun.serve<SocketData>(serverConfig);

logger.info("SystemX server ready", {
  port: server.port,
  hostname: host,
  protocol: tlsEnabled ? "wss" : "ws",
  tls: tlsEnabled,
});

// Start built-in log streaming service
const logService = new LogStreamService(router, logger);
logService.start();

const federationConfig = loadFederationConfig(logger);
const federationManager = federationConfig ? createFederationManager(router, logger, federationConfig) : null;
if (federationManager) {
  federationManager.start();
}

const pruneIntervalMs = Math.max(heartbeatIntervalMs, 5_000);
const pruneTimer = setInterval(() => {
  router.pruneStaleConnections();
}, pruneIntervalMs);

const shutdown = (signal: string) => {
  logger.info("Shutting down SystemX server", { signal });
  clearInterval(pruneTimer);
  logService.stop();
  federationManager?.stop();
  server.stop();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
