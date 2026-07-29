import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createDurableDiscordRequestStore } from "./durableRequestStore.js";

describe("durable Discord request store", () => {
  it("persists requests in creation order and removes them only after delivery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "discord-durable-"));
    const store = createDurableDiscordRequestStore(root, {
      now: () => Date.parse("2026-07-21T00:00:10.000Z"),
    });

    try {
      await store.enqueue({
        requestId: "request-2",
        channelId: "thread-1",
        userId: "user-1",
        content: "second",
        roleIds: ["role-1"],
        authorBot: true,
        messageId: "discord-message-2",
        relayRequest: true,
        createdAt: "2026-07-21T00:00:02.000Z",
      });
      await store.enqueue({
        requestId: "request-1",
        channelId: "thread-1",
        userId: "user-1",
        content: "first",
        roleIds: ["role-1"],
        createdAt: "2026-07-21T00:00:01.000Z",
      });

      await expect(store.list()).resolves.toMatchObject([
        { requestId: "request-1", content: "first" },
        {
          requestId: "request-2",
          content: "second",
          authorBot: true,
          messageId: "discord-message-2",
          relayRequest: true,
        },
      ]);
      await store.remove("request-1");
      await expect(store.list()).resolves.toMatchObject([{ requestId: "request-2" }]);
      if (process.platform !== "win32") {
        expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect((await stat(path.join(root, "request-2.json"))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expires stale requests and enforces queue limits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "discord-durable-limits-"));
    const now = Date.parse("2026-07-21T00:00:10.000Z");
    const store = createDurableDiscordRequestStore(root, {
      now: () => now,
      ttlMs: 5_000,
      maxRequests: 1,
      maxBytes: 100_000,
      maxRequestBytes: 10_000,
    });

    try {
      await store.enqueue({
        requestId: "expired",
        channelId: "thread-1",
        userId: "user-1",
        content: "old secret",
        roleIds: [],
        createdAt: "2026-07-21T00:00:00.000Z",
      });
      await expect(store.list()).resolves.toEqual([]);

      await store.enqueue({
        requestId: "current",
        channelId: "thread-1",
        userId: "user-1",
        content: "current",
        roleIds: [],
      });
      await expect(store.enqueue({
        requestId: "overflow",
        channelId: "thread-1",
        userId: "user-1",
        content: "overflow",
        roleIds: [],
      })).rejects.toThrow("1 request limit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("moves malformed request files to dead-letter instead of retrying them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "discord-durable-invalid-"));
    const store = createDurableDiscordRequestStore(root);

    try {
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "broken.json"), "{not-json");
      await expect(store.list()).resolves.toEqual([]);
      const deadLetters = await readdir(path.join(root, "dead-letter"));
      expect(deadLetters.some((entry) => entry.endsWith(".json") && !entry.endsWith(".error.json"))).toBe(true);
      expect(deadLetters.some((entry) => entry.endsWith(".error.json"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("limits queue JSON independently from attachment files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "discord-durable-bytes-"));
    const perRequestStore = createDurableDiscordRequestStore(root, {
      ttlMs: 0,
      maxRequests: 0,
      maxBytes: 0,
      maxRequestBytes: 300,
    });

    try {
      await expect(perRequestStore.enqueue({
        requestId: "oversized",
        channelId: "thread-1",
        userId: "user-1",
        content: "x".repeat(300),
        roleIds: [],
      })).rejects.toThrow("exceeds 300 bytes");

      const totalStore = createDurableDiscordRequestStore(root, {
        ttlMs: 0,
        maxRequests: 0,
        maxBytes: 500,
        maxRequestBytes: 0,
      });
      await totalStore.enqueue({
        requestId: "first",
        channelId: "thread-1",
        userId: "user-1",
        content: "x".repeat(120),
        roleIds: [],
      });
      await expect(totalStore.enqueue({
        requestId: "second",
        channelId: "thread-1",
        userId: "user-1",
        content: "x".repeat(120),
        roleIds: [],
      })).rejects.toThrow("500 byte limit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
