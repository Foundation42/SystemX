type Message = Record<string, any> & { type: string };

export class IntegrationClient {
  private readonly messages: Message[] = [];
  private isOpen = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly onClose: (code: number, reason: string) => void,
  ) {
    ws.addEventListener("open", () => {
      this.isOpen = true;
    });
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const payload = JSON.parse(raw) as Message;
      this.messages.push(payload);
      this.resolvers = this.resolvers.filter(({ type, resolve }) => {
        if (payload.type === type) {
          resolve(payload);
          return false;
        }
        return true;
      });
    });
    ws.addEventListener("close", (event) => {
      this.onClose(event.code, event.reason);
      this.rejectAll(new Error(`Socket closed: ${event.code} ${event.reason}`));
    });
    ws.addEventListener("error", (event) => {
      this.rejectAll(new Error(`Socket error: ${event}`));
    });
  }

  private resolvers: Array<{
    type: string;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  }> = [];

  private rejectAll(error: Error) {
    for (const pending of this.resolvers) {
      pending.reject(error);
    }
    this.resolvers = [];
  }

  async waitForOpen(timeoutMs = 2_000) {
    if (this.isOpen) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for socket open"));
      }, timeoutMs);
      this.ws.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });
  }

  send(message: Record<string, unknown>) {
    this.ws.send(JSON.stringify(message));
  }

  async waitForType(type: string, timeoutMs = 2_000): Promise<Message> {
    for (const message of this.messages) {
      if (message.type === type) {
        return message;
      }
    }
    return new Promise<Message>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for message type ${type}`));
      }, timeoutMs);
      this.resolvers.push({
        type,
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  close() {
    this.ws.close();
  }
}
