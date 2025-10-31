import type { SystemXRouter } from "./router";
import type { Logger, LogLevel } from "./logger";
import type { MessageTransport, ConnectionContext } from "./connection";
import { randomUUID } from "crypto";

const LOG_BUFFER_SIZE = 100;
const BROADCAST_ADDRESS = "logs@system.local";

export class LogStreamService {
  private router: SystemXRouter;
  private logger: Logger;
  private connection: ConnectionContext | null = null;
  private callId: string | null = null;
  private listenerCount = 0;
  private logBuffer: string[] = [];
  private originalLogger: Logger;

  constructor(router: SystemXRouter, logger: Logger) {
    this.router = router;
    this.logger = logger;
    this.originalLogger = logger;
  }

  start() {
    // Create internal transport that handles messages
    const transport: MessageTransport = {
      send: (message) => {
        this.handleMessage(message);
      },
      close: () => {
        // Internal service doesn't close
      },
    };

    // Create connection for the log service
    this.connection = this.router.createConnection({
      id: randomUUID(),
      transport,
    });

    // Register as broadcast service
    this.router.handleMessage(this.connection, {
      type: "REGISTER",
      address: BROADCAST_ADDRESS,
      concurrency: "broadcast",
      max_listeners: 1000,
      metadata: {
        service: "log_stream",
        description: "SystemX log streaming service",
      },
    });

    // Wrap logger to capture logs
    this.wrapLogger();

    this.logger.info("Log streaming service registered", {
      address: BROADCAST_ADDRESS,
      mode: "broadcast",
    });
  }

  private handleMessage(message: Record<string, unknown>) {
    switch (message.type) {
      case "REGISTERED":
        this.logger.debug("Log service registered in broadcast mode");
        break;

      case "RING":
        this.listenerCount++;
        this.callId = message.call_id as string;

        this.logger.info("New log stream listener", {
          from: message.from,
          totalListeners: this.listenerCount,
        });

        // Answer the call
        if (this.connection) {
          this.router.handleMessage(this.connection, {
            type: "ANSWER",
            call_id: this.callId,
          });
        }

        // Send welcome message and buffered logs
        this.sendWelcomeMessage(message.from as string);
        break;

      case "HANGUP":
        this.listenerCount = Math.max(0, this.listenerCount - 1);

        this.logger.info("Log stream listener disconnected", {
          remainingListeners: this.listenerCount,
        });

        if (this.listenerCount === 0) {
          this.callId = null;
        }
        break;

      case "MSG":
        // Listeners can send commands (future: filter levels, etc.)
        this.logger.debug("Message from log listener", {
          from: message.from,
          data: message.data,
        });
        break;
    }
  }

  private sendWelcomeMessage(from: string) {
    if (!this.callId || !this.connection) return;

    // Send welcome
    setTimeout(() => {
      if (this.callId && this.connection) {
        this.router.handleMessage(this.connection, {
          type: "MSG",
          call_id: this.callId,
          data: `\x1b[1;36m📡 SystemX Log Stream\x1b[0m\n\x1b[2mWelcome ${from}\x1b[0m\n\x1b[2m${this.logBuffer.length} recent log entries:\x1b[0m\n\n`,
          content_type: "text",
        });

        // Send buffered logs
        for (const logLine of this.logBuffer) {
          this.router.handleMessage(this.connection, {
            type: "MSG",
            call_id: this.callId,
            data: logLine + "\n",
            content_type: "text",
          });
        }

        this.router.handleMessage(this.connection, {
          type: "MSG",
          call_id: this.callId,
          data: "\x1b[2m--- Live log stream ---\x1b[0m\n",
          content_type: "text",
        });
      }
    }, 100);
  }

  private wrapLogger() {
    const self = this;
    const originalDebug = this.originalLogger.debug.bind(this.originalLogger);
    const originalInfo = this.originalLogger.info.bind(this.originalLogger);
    const originalWarn = this.originalLogger.warn.bind(this.originalLogger);
    const originalError = this.originalLogger.error.bind(this.originalLogger);

    this.originalLogger.debug = function(message: string, context?: Record<string, unknown>) {
      originalDebug(message, context);
      self.broadcastLog("debug", message, context);
    };

    this.originalLogger.info = function(message: string, context?: Record<string, unknown>) {
      originalInfo(message, context);
      self.broadcastLog("info", message, context);
    };

    this.originalLogger.warn = function(message: string, context?: Record<string, unknown>) {
      originalWarn(message, context);
      self.broadcastLog("warn", message, context);
    };

    this.originalLogger.error = function(message: string, context?: Record<string, unknown>) {
      originalError(message, context);
      self.broadcastLog("error", message, context);
    };
  }

  private broadcastLog(level: LogLevel, message: string, context?: Record<string, unknown>) {
    // Format log with ANSI colors
    const colorMap: Record<LogLevel, string> = {
      debug: "\x1b[2m",      // dim
      info: "\x1b[36m",       // cyan
      warn: "\x1b[33m",       // yellow
      error: "\x1b[31m",      // red
    };

    const color = colorMap[level];
    const reset = "\x1b[0m";
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(context)}` : "";
    const logLine = `${color}[${level.toUpperCase()}]${reset} \x1b[2m${timestamp}\x1b[0m ${message}${contextStr}`;

    // Add to buffer
    this.logBuffer.push(logLine);
    if (this.logBuffer.length > LOG_BUFFER_SIZE) {
      this.logBuffer.shift();
    }

    // Broadcast to listeners if any
    if (this.callId && this.connection && this.listenerCount > 0) {
      this.router.handleMessage(this.connection, {
        type: "MSG",
        call_id: this.callId,
        data: logLine + "\n",
        content_type: "text",
      });
    }
  }

  stop() {
    if (this.connection) {
      this.router.disconnect(this.connection, "service_shutdown");
    }
  }
}
