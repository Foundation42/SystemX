import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from "node:timers";
import { BaseTransport } from "./transport";
import type { TransportConnectOptions, TransportOptions } from "./transport";

export interface FederationWebSocketOptions extends TransportOptions {
  protocols?: string | string[];
  reconnect?: {
    delayMs: number;
  };
}

type CloseHandler = (code: number, reason?: string) => void;

function toCloseHandler(handler: CloseHandler) {
  return (event: any) => {
    handler(event.code ?? 1006, event.reason || undefined);
  };
}

function normalizeMessage(data: unknown): unknown {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  return data;
}

export class FederationWebSocketTransport extends BaseTransport {
  private socket: WebSocket | null = null;
  private readonly connectOptions: FederationWebSocketOptions;

  constructor(options: FederationWebSocketOptions = {}) {
    super();
    this.connectOptions = options;
  }

  async connect({ url, protocols }: TransportConnectOptions): Promise<void> {
    if (this.socket) {
      return;
    }
    const WebSocketImpl = globalThis.WebSocket;
    if (!WebSocketImpl) {
      throw new Error("WebSocket implementation not available in this runtime");
    }

    this.transition("connecting");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocketImpl(url, protocols ?? this.connectOptions.protocols);
      this.socket = socket;

      let timeout: ReturnType<typeof setNodeTimeout> | null = null;
      if (this.connectOptions.connectTimeoutMs) {
        timeout = setNodeTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          this.transition("closed");
          socket.close(4000, "connect_timeout");
          this.socket = null;
          reject(new Error(`WebSocket connect timeout after ${this.connectOptions.connectTimeoutMs}ms`));
        }, this.connectOptions.connectTimeoutMs);
      }

      const handleOpen = () => {
        this.transition("open");
        this.emit("open");
        socket.removeEventListener("open", handleOpen);
        if (!settled) {
          settled = true;
          if (timeout) {
            clearNodeTimeout(timeout);
            timeout = null;
          }
          resolve();
        }
      };

      const handleClose = toCloseHandler((code, reason) => {
        this.transition("closed");
        this.socket = null;
        this.emit("close", code, reason);
        socket.removeEventListener("message", handleMessage as EventListener);
        socket.removeEventListener("error", handleError as EventListener);
        if (!settled) {
          settled = true;
          if (timeout) {
            clearNodeTimeout(timeout);
            timeout = null;
          }
          reject(new Error(`WebSocket closed before opening (code ${code})`));
        }
      });

      const handleError = (event: any) => {
        const error = event?.error instanceof Error ? (event.error as Error) : new Error("WebSocket error");
        this.emit("error", error);
        if (!settled && this.state === "connecting") {
          settled = true;
          if (timeout) {
            clearNodeTimeout(timeout);
            timeout = null;
          }
          this.transition("closed");
          this.socket = null;
          reject(error);
        }
      };

      const handleMessage = (event: any) => {
        this.emit("message", normalizeMessage(event.data));
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("close", handleClose as EventListener);
      socket.addEventListener("error", handleError as EventListener);
      socket.addEventListener("message", handleMessage as EventListener);
    });
  }

  send(data: unknown): void {
    if (!this.socket || this.state !== "open") {
      throw new Error("FederationWebSocketTransport is not open");
    }
    if (
      typeof data === "string" ||
      (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) ||
      data instanceof ArrayBuffer ||
      ArrayBuffer.isView(data)
    ) {
      this.socket.send(data as any);
      return;
    }
    this.socket.send(JSON.stringify(data));
  }

  close(code?: number, reason?: string): void {
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.transition("closing");
    socket.close(code, reason);
    this.socket = null;
  }
}

export function createFederationWebSocketTransport(options?: FederationWebSocketOptions) {
  return new FederationWebSocketTransport(options);
}
