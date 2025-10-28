import { Logger } from "./logger";
import { WakeHandlerConfig } from "./types";

export interface WakeProfile {
  address: string;
  handler: WakeHandlerConfig;
}

export interface WakeExecutor {
  wake(profile: WakeProfile): Promise<void>;
}

export class NoopWakeExecutor implements WakeExecutor {
  constructor(private readonly logger: Logger) {}

  async wake(profile: WakeProfile): Promise<void> {
    this.logger.info("Wake executor noop", {
      address: profile.address,
      handlerType: profile.handler.type,
    });
  }
}

export class DefaultWakeExecutor implements WakeExecutor {
  constructor(private readonly logger: Logger) {}

  async wake(profile: WakeProfile): Promise<void> {
    if (profile.handler.type === "webhook") {
      await this.invokeWebhook(profile);
      return;
    }
    if (profile.handler.type === "spawn") {
      await this.spawnProcess(profile);
      return;
    }
    throw new Error(`Unsupported wake handler type: ${profile.handler.type}`);
  }

  private async invokeWebhook(profile: WakeProfile) {
    const timeoutMs = Math.max(profile.handler.timeout_seconds * 1000, 100);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(profile.handler.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: profile.address,
          handler: profile.handler,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`webhook_status_${response.status}`);
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error("webhook_timeout");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async spawnProcess(profile: WakeProfile) {
    const timeoutMs = Math.max(profile.handler.timeout_seconds * 1000, 100);
    const proc = Bun.spawn(profile.handler.command, {
      stdout: "ignore",
      stderr: "inherit",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    if (timedOut) {
      throw new Error("spawn_timeout");
    }
    if (exitCode !== 0) {
      throw new Error(`spawn_exit_${exitCode}`);
    }
  }
}

export function createWakeExecutor(logger: Logger): WakeExecutor {
  return new DefaultWakeExecutor(logger);
}
