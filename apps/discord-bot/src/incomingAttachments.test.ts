import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendDiscordAttachmentsToPrompt,
  createIncomingAttachmentStore,
} from "./incomingAttachments.js";

describe("incoming Discord attachments", () => {
  it("downloads Discord CDN attachments to a private local path and describes them in the prompt", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-discord-attachments-"));
    const fetchImpl = vi.fn().mockResolvedValue(new Response(Buffer.from("video-bytes"), {
      status: 200,
      headers: { "content-length": "11", "content-type": "video/mp4" },
    })) as unknown as typeof fetch;
    const store = createIncomingAttachmentStore({ rootPath: tempRoot, fetchImpl });

    try {
      const files = await store.materialize({
        messageId: "message-1",
        attachments: [{
          id: "attachment-1",
          name: "../demo video.mp4",
          url: "https://cdn.discordapp.com/attachments/channel/message/demo.mp4?ex=signed",
          contentType: "video/mp4",
          size: 11,
        }],
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(files).toEqual([expect.objectContaining({
        name: "../demo video.mp4",
        contentType: "video/mp4",
        size: 11,
        localPath: expect.stringMatching(/message-1[/\\]attachment-1-demo video\.mp4$/),
      })]);
      await expect(readFile(files[0]!.localPath, "utf8")).resolves.toBe("video-bytes");

      const prompt = appendDiscordAttachmentsToPrompt("이 영상을 확인해줘.", files);
      expect(prompt).toContain("이 영상을 확인해줘.");
      expect(prompt).toContain(JSON.stringify(files[0]!.localPath));
      expect(prompt).toContain('"contentType": "video/mp4"');
      expect(prompt).not.toContain("cdn.discordapp.com");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-Discord hosts and files over the configured limit", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-discord-attachments-"));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const store = createIncomingAttachmentStore({
      rootPath: tempRoot,
      fetchImpl,
      maxBytesPerFile: 4,
    });

    try {
      await expect(store.materialize({
        messageId: "message-1",
        attachments: [{
          id: "attachment-1",
          name: "secret.txt",
          url: "https://example.com/secret.txt",
          contentType: "text/plain",
          size: 1,
        }],
      })).rejects.toThrow("unsupported host");

      await expect(store.materialize({
        messageId: "message-2",
        attachments: [{
          id: "attachment-2",
          name: "large.bin",
          url: "https://cdn.discordapp.com/attachments/channel/message/large.bin",
          contentType: "application/octet-stream",
          size: 5,
        }],
      })).rejects.toThrow("개별 크기 제한");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reads attachment root and limits from environment variables", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-discord-attachments-env-"));
    const previousRoot = process.env.CONNECT_INCOMING_ATTACHMENT_ROOT;
    const previousMaxFiles = process.env.CONNECT_INCOMING_ATTACHMENT_MAX_FILES;

    try {
      process.env.CONNECT_INCOMING_ATTACHMENT_ROOT = tempRoot;
      process.env.CONNECT_INCOMING_ATTACHMENT_MAX_FILES = "1";
      const store = createIncomingAttachmentStore({ fetchImpl: vi.fn() as unknown as typeof fetch });

      expect(store.rootPath).toBe(tempRoot);
      await expect(store.materialize({
        messageId: "message-1",
        attachments: [
          {
            id: "attachment-1",
            name: "one.txt",
            url: "https://cdn.discordapp.com/attachments/channel/message/one.txt",
            contentType: "text/plain",
            size: 1,
          },
          {
            id: "attachment-2",
            name: "two.txt",
            url: "https://cdn.discordapp.com/attachments/channel/message/two.txt",
            contentType: "text/plain",
            size: 1,
          },
        ],
      })).rejects.toThrow("최대 1개");
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CONNECT_INCOMING_ATTACHMENT_ROOT;
      } else {
        process.env.CONNECT_INCOMING_ATTACHMENT_ROOT = previousRoot;
      }
      if (previousMaxFiles === undefined) {
        delete process.env.CONNECT_INCOMING_ATTACHMENT_MAX_FILES;
      } else {
        process.env.CONNECT_INCOMING_ATTACHMENT_MAX_FILES = previousMaxFiles;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
