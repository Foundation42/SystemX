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
