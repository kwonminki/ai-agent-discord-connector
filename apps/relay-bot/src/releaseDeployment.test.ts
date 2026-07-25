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
      "active 또는 pending 요청이 하나라도 있으면 worker에 SIGTERM, SIGKILL, restart, stop, kill 신호를 보내지 않는다.",
    );
    expect(prompt).toContain(
      "worker의 active와 pending이 모두 0이고 supervisor가 확인된 경우에만 worker를 graceful restart한다.",
    );
    expect(prompt).toContain("SIGKILL");
  });
});
