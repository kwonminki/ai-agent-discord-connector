import { describe, expect, it } from "vitest";

import type { ConnectorPresence } from "../../../packages/core/src/index.js";
import {
  buildReleaseUpdatePrompt,
  formatReleaseFooter,
  parseReleaseFooter,
  parseReleaseUpdateButtonId,
  releaseUpdateButtonId,
  selectConnectorUpdateTargets,
} from "./releaseDeployment.js";

const release = {
  version: "1.3.0-beta.1",
  sha: "4350badd29956203dda8431663456b89ec0ff8dd",
};

function presence(input: Partial<ConnectorPresence> & Pick<ConnectorPresence, "computerId">): ConnectorPresence {
  return {
    version: 1,
    discoveryId: "30519a6b-5fd5-4944-9fd2-2e3293c1c925",
    computerDisplayName: input.computerId,
    connectorVersion: "1.2.0",
    preferredAgent: "codex",
    channels: {
      codex: "100",
      claude: null,
    },
    maintenance: {
      agent: "codex",
      channelId: "199",
    },
    registeredAt: "2026-07-24T00:00:00.000Z",
    ...input,
  };
}

describe("release deployment", () => {
  it("round-trips release footer and button identifiers", () => {
    expect(parseReleaseFooter(formatReleaseFooter(release))).toEqual(release);
    expect(parseReleaseUpdateButtonId(releaseUpdateButtonId(release))).toEqual(release);
    expect(parseReleaseUpdateButtonId("agent-release-update:bad")).toBeNull();
  });

  it("selects one dedicated maintenance thread per computer", () => {
    const targets = selectConnectorUpdateTargets([
      presence({
        computerId: "server-a",
        computerDisplayName: "Server A",
        preferredAgent: "codex",
        channels: { codex: "101", claude: "102" },
        maintenance: { agent: "codex", channelId: "191" },
      }),
      presence({
        computerId: "server-b",
        computerDisplayName: "Server B",
        preferredAgent: "claude",
        channels: { codex: "201", claude: "202" },
        maintenance: { agent: "claude", channelId: "292" },
      }),
      presence({
        computerId: "server-b",
        computerDisplayName: "Server B stale",
        preferredAgent: "codex",
        channels: { codex: "203", claude: null },
        maintenance: { agent: "codex", channelId: "293" },
        registeredAt: "2026-07-23T00:00:00.000Z",
      }),
      presence({
        computerId: "server-c",
        computerDisplayName: "Server C",
        preferredAgent: "claude",
        channels: { codex: "301", claude: null },
        maintenance: { agent: "codex", channelId: "391" },
      }),
      presence({
        computerId: "legacy-server",
        computerDisplayName: "Legacy Server",
        maintenance: undefined,
      }),
    ]);

    expect(targets).toEqual([
      expect.objectContaining({ computerId: "server-a", agent: "codex", channelId: "191" }),
      expect.objectContaining({ computerId: "server-b", agent: "claude", channelId: "292" }),
      expect.objectContaining({ computerId: "server-c", agent: "codex", channelId: "391" }),
    ]);
  });

  it("builds a safe exact-commit maintenance prompt", () => {
    const prompt = buildReleaseUpdatePrompt(release, {
      computerId: "server-a",
      computerDisplayName: "Server A",
      connectorVersion: "1.2.0",
      agent: "codex",
      channelId: "101",
    });

    expect(prompt).toContain(release.sha);
    expect(prompt).toContain("ff-only");
    expect(prompt).toContain(
      "이 maintenance 요청 자체가 대상 worker에서 실행 중인 active job이다.",
    );
    expect(prompt).toContain(
      "active/pending 수와 무관하게 worker에 SIGTERM, SIGKILL, restart, stop, kill 또는 reload 신호를 절대 보내지 않는다.",
    );
    expect(prompt).toContain("systemd-run");
    expect(prompt).toContain("worker 적용 상태는 반드시 `deferred`");
    expect(prompt).toContain("SIGKILL");
  });
});
