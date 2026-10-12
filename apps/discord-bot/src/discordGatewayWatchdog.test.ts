import { EventEmitter } from "node:events";
import { Collection, Status, type Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchDiscordGateway } from "./discordGatewayWatchdog.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function setup(ready = false) {
  const shard = { status: ready ? Status.Ready : Status.Connecting };
  const client = Object.assign(new EventEmitter(), { isReady: vi.fn(() => ready), ws: { shards: new Collection([[0, shard]]) } });
  const restart = vi.fn();
  const stop = watchDiscordGateway(client as unknown as Client, restart);
  return { client, shard, restart, stop };
}

describe("Discord gateway recovery", () => {
  it("bounds a hung initial login and requests one gateway restart", () => {
    const { client, restart } = setup();
    client.ws.shards.clear();
    vi.advanceTimersByTime(119_999);
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(restart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300_000);
    expect(restart).toHaveBeenCalledTimes(1);
  });
  it("detects a stuck shard even when the client's overall ready flag stays true", () => {
    const { shard, restart } = setup(true);
    vi.advanceTimersByTime(10_000);
    shard.status = Status.Resuming;
    vi.advanceTimersByTime(130_000);
    expect(restart).toHaveBeenCalledTimes(1);
  });
  it("lets normal reconnect recover and resets the deadline for a later outage", () => {
    const { client, shard, restart, stop } = setup();
    vi.advanceTimersByTime(110_000);
    client.isReady.mockReturnValue(true); shard.status = Status.Ready;
    vi.advanceTimersByTime(120_000);
    expect(restart).not.toHaveBeenCalled();
    shard.status = Status.Reconnecting;
    vi.advanceTimersByTime(120_000);
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(restart).toHaveBeenCalledTimes(1);
    stop();
  });
  it("does not mistake an idle healthy gateway for a stalled connection", () => {
    const { restart, stop } = setup(true);
    vi.advanceTimersByTime(24 * 3600_000);
    expect(restart).not.toHaveBeenCalled();
    stop();
  });
  it("handles network errors without logging secrets or extending the outage", () => {
    const { client, restart } = setup();
    for (let i = 0; i < 11; i++) {
      client.emit("error", { code: "ECONNRESET", token: "secret", content: "private prompt" });
      client.emit("shardError", new Error("secret"), 0);
      vi.advanceTimersByTime(10_000);
    }
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/secret|private prompt/);
    vi.advanceTimersByTime(10_000);
    expect(restart).toHaveBeenCalledTimes(1);
  });
  it("cleans up its timer and listeners", () => {
    const { client, stop, restart } = setup();
    stop();
    expect(client.listenerCount("error")).toBe(0);
    expect(client.listenerCount("shardError")).toBe(0);
    vi.advanceTimersByTime(300_000);
    expect(restart).not.toHaveBeenCalled();
  });
});
