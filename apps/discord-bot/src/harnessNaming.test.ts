import { describe, expect, it } from "vitest";
import { harnessBuilderThreadName, harnessRunThreadName } from "./harnessNaming.js";

describe("Harness Discord thread names", () => {
  it("derives Builder and Run names from the original thread", () => {
    expect(harnessBuilderThreadName({ sourceName: "디스커드봇 하네스" })).toBe(
      "디스커드봇 하네스 · 🧩 Harness Builder",
    );
    expect(harnessRunThreadName({
      sourceName: "디스커드봇 하네스",
      harnessName: "connector-safe-release",
      version: "1.2.0",
    })).toBe("디스커드봇 하네스 · 🧰 connector-safe-release v1.2.0");
  });

  it("preserves the descriptive suffix when the original name is long", () => {
    const name = harnessRunThreadName({
      sourceName: "매우 긴 원본 작업 스레드 이름 ".repeat(10),
      harnessName: "safe-release",
      version: "2.0.0",
    });

    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).toContain(" · 🧰 safe-release v2.0.0");
  });

  it("keeps an explicitly requested name", () => {
    expect(harnessBuilderThreadName({
      sourceName: "원본",
      requestedName: "내 전용 빌더",
    })).toBe("내 전용 빌더");
  });
});
