import { randomUUID } from "crypto";
import { ConnectionContext } from "./connection";

export type CallState = {
  callId: string;
  caller: ConnectionContext;
  callee: ConnectionContext;
  state: "ringing" | "connected" | "ended";
  metadata?: Record<string, unknown>;
  startedAt: number;
  endedAt?: number;
  endReason?: string;
};

export class CallManager {
  private readonly calls = new Map<string, CallState>();

  createCall(params: {
    caller: ConnectionContext;
    callee: ConnectionContext;
    metadata?: Record<string, unknown>;
    callId?: string;
  }): CallState {
    const callId = params.callId ?? randomUUID();
    const call: CallState = {
      callId,
      caller: params.caller,
      callee: params.callee,
      metadata: params.metadata,
      state: "ringing",
      startedAt: Date.now(),
    };
    this.calls.set(callId, call);
    return call;
  }

  getCall(callId: string): CallState | undefined {
    return this.calls.get(callId);
  }

  setConnected(callId: string) {
    const call = this.calls.get(callId);
    if (!call) {
      return;
    }
    call.state = "connected";
  }

  endCall(callId: string, reason: string) {
    const call = this.calls.get(callId);
    if (!call) {
      return;
    }
    call.state = "ended";
    call.endReason = reason;
    call.endedAt = Date.now();
  }

  release(callId: string) {
    this.calls.delete(callId);
  }
}
