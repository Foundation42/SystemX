import { randomUUID } from "crypto";

type CliOptions = {
  address: string;
  dial?: string;
  autoAnswer: boolean;
  message?: string;
};

type InboundMessage = Record<string, any> & { type: string };

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    address: `user-${randomUUID()}@example.com`,
    autoAnswer: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    switch (key) {
      case "--address":
        if (value) {
          options.address = value;
          i += 1;
        }
        break;
      case "--dial":
        if (value) {
          options.dial = value;
          i += 1;
        }
        break;
      case "--auto-answer":
        options.autoAnswer = true;
        break;
      case "--no-auto-answer":
        options.autoAnswer = false;
        break;
      case "--message":
        if (value) {
          options.message = value;
          i += 1;
        }
        break;
      default:
        break;
    }
  }

  return options;
}

const options = parseArgs(Bun.argv.slice(2));
const serverUrl = process.env.SYSTEMX_URL ?? "ws://localhost:8080";

const socket = new WebSocket(serverUrl);

let activeCallId: string | null = null;
let peerAddress: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function send(payload: Record<string, unknown>) {
  socket.send(JSON.stringify(payload));
}

function scheduleHeartbeat() {
  heartbeatTimer = setInterval(() => {
    send({ type: "HEARTBEAT" });
  }, 15_000);
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

socket.addEventListener("open", () => {
  console.log(`Connected to ${serverUrl}`);
  send({
    type: "REGISTER",
    address: options.address,
    metadata: {
      client: "simple-client",
      autoAnswer: options.autoAnswer,
    },
  });
  scheduleHeartbeat();
});

socket.addEventListener("message", (event) => {
  try {
    const payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as InboundMessage;
    console.log("←", payload);
    handleInbound(payload);
  } catch (error) {
    console.error("Failed to parse message", error);
  }
});

socket.addEventListener("close", (event) => {
  clearHeartbeat();
  console.log(`Connection closed (${event.code}) ${event.reason}`);
  process.exit(0);
});

socket.addEventListener("error", (error) => {
  console.error("WebSocket error", error);
});

function handleInbound(message: InboundMessage) {
  switch (message.type) {
    case "REGISTERED":
      if (options.dial) {
        send({
          type: "DIAL",
          to: options.dial,
        });
      }
      break;
    case "RING":
      peerAddress = message.from as string;
      activeCallId = message.call_id as string;
      if (options.autoAnswer) {
        console.log(`Answering call from ${peerAddress}`);
        send({
          type: "ANSWER",
          call_id: activeCallId,
        });
      } else {
        console.log("Incoming call. Use CTRL+C to reject.");
      }
      break;
    case "CONNECTED":
      activeCallId = message.call_id as string;
      peerAddress = (message.to as string) ?? peerAddress;
      if (options.message) {
        send({
          type: "MSG",
          call_id: activeCallId,
          data: options.message,
          content_type: "text",
        });
      }
      console.log(`Call connected with ${peerAddress}`);
      break;
    case "MSG":
      console.log(`${message.from}: ${message.data}`);
      break;
    case "HANGUP":
      console.log(`Call ended (${message.reason ?? "normal"})`);
      activeCallId = null;
      peerAddress = null;
      break;
    case "BUSY":
      console.log(`Dial failed: ${message.reason}`);
      break;
    default:
      break;
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const text = chunk.trim();
  if (!text) {
    return;
  }
  if (!activeCallId) {
    console.log("No active call. Text ignored.");
    return;
  }
  send({
    type: "MSG",
    call_id: activeCallId,
    data: text,
    content_type: "text",
  });
});

function shutdown() {
  clearHeartbeat();
  if (socket.readyState === WebSocket.OPEN) {
    if (activeCallId) {
      send({ type: "HANGUP", call_id: activeCallId });
    }
    send({ type: "UNREGISTER" });
  }
  setTimeout(() => process.exit(0), 100);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
