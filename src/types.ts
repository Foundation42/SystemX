import type { Logger } from "./logger";

export type PresenceStatus = "available" | "busy" | "dnd" | "away";

export type ConcurrencyMode = "single" | "broadcast" | "parallel";

export type WakeMode = "wake_on_ring";

export type WakeHandlerConfig =
  | {
      type: "webhook";
      url: string;
      timeout_seconds: number;
      payload?: Record<string, unknown>;
    }
  | {
      type: "spawn";
      command: string[];
      timeout_seconds: number;
  };

export type RegisterMessage = {
  type: "REGISTER";
  address: string;
  auth?: string;
  metadata?: Record<string, unknown>;
  mode?: WakeMode;
  wake_handler?: WakeHandlerConfig;
  concurrency?: ConcurrencyMode;
  max_listeners?: number;
  max_sessions?: number;
  pool_size?: number;
};

export type StatusMessage = {
  type: "STATUS";
  status: PresenceStatus;
  auto_sleep?: {
    idle_timeout_seconds: number;
    wake_on_ring: boolean;
  };
};

export type UnregisterMessage = {
  type: "UNREGISTER";
};

export type HeartbeatMessage = {
  type: "HEARTBEAT";
};

export type DialMessage = {
  type: "DIAL";
  to: string;
  metadata?: Record<string, unknown>;
};

export type AnswerMessage = {
  type: "ANSWER";
  call_id: string;
};

export type HangupMessage = {
  type: "HANGUP";
  call_id: string;
  reason?: string;
};

export type MsgMessage = {
  type: "MSG";
  call_id: string;
  data: unknown;
  content_type?: "text" | "json" | "binary";
};

export type PresenceQuery = {
  domain?: string;
  capabilities?: string[];
  near?: {
    lat: number;
    lon: number;
    radius_km: number;
  };
};

export type PresenceMessage = {
  type: "PRESENCE";
  query?: PresenceQuery;
};

export type SleepAckMessage = {
  type: "SLEEP_ACK";
};

export type RouterInboundMessage =
  | RegisterMessage
  | StatusMessage
  | UnregisterMessage
  | HeartbeatMessage
  | DialMessage
  | AnswerMessage
  | HangupMessage
  | MsgMessage
  | PresenceMessage
  | SleepAckMessage
  | Record<string, unknown>;

export type RegisterFailureReason = "address_in_use" | "invalid_address" | "auth_failed";

export type RouterOptions = {
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  logger?: Logger;
  callRingingTimeoutMs?: number;
  dialRateLimit?: {
    maxAttempts: number;
    windowMs: number;
  };
  wakeExecutor?: import("./wake").WakeExecutor;
};
