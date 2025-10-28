export type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  level: LogLevel;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

type ConsoleMethod = "log" | "warn" | "error";

export class ConsoleLogger implements Logger {
  public level: LogLevel;

  constructor(level?: LogLevel) {
    this.level = level ?? "info";
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>) {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.log("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>) {
    this.log("error", message, context);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>) {
    if (levelPriority[level] < levelPriority[this.level]) {
      return;
    }
    const payload = context ? ` ${JSON.stringify(context)}` : "";
    const line = `[${level.toUpperCase()}] ${message}${payload}`;
    const method: ConsoleMethod =
      level === "debug" || level === "info"
        ? "log"
        : level === "warn"
        ? "warn"
        : "error";
    console[method](line);
  }
}

function parseLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower === "debug" || lower === "info" || lower === "warn" || lower === "error") {
    return lower;
  }
  return undefined;
}

export const logger = new ConsoleLogger(parseLogLevel(process.env.SYSTEMX_LOG_LEVEL));
