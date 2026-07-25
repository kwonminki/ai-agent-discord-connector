import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CWD_PICKER_IDS,
  buildCwdPickerPayload,
  cwdPickerChildPath,
  cwdPickerParentPath,
  isCwdPickerComponent,
  listCwdPickerSubdirectories,
  parseCwdPickerState,
} from "./cwdPicker.js";
import type { DiscordSelectMenuPayload } from "./responses.js";

describe("cwd picker", () => {
  it("lists only visible subdirectories, sorted", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cwd-picker-"));

    try {
      await mkdir(path.join(tempRoot, "beta"));
      await mkdir(path.join(tempRoot, "Alpha"));
      await mkdir(path.join(tempRoot, ".hidden"));
      await writeFile(path.join(tempRoot, "file.txt"), "x", "utf8");

      const listing = await listCwdPickerSubdirectories(tempRoot);
      expect(listing.error).toBeNull();
      expect(listing.dirs).toEqual(["Alpha", "beta"]);

      const missing = await listCwdPickerSubdirectories(path.join(tempRoot, "does-not-exist"));
      expect(missing.dirs).toEqual([]);
      expect(missing.error).toBeTruthy();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("builds a picker payload whose state round-trips through the message content", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cwd-picker-payload-"));

    try {
      await mkdir(path.join(tempRoot, "projects"));
      await mkdir(path.join(tempRoot, "docs"));

      const payload = await buildCwdPickerPayload({ path: tempRoot });
      expect(payload.content).toContain(`📁 \`${tempRoot}\``);
      expect(payload.content).toContain("하위 폴더 2개 · 페이지 1/1");

      const select = payload.components?.[0]?.components?.[0] as DiscordSelectMenuPayload;
      expect(select.custom_id).toBe(CWD_PICKER_IDS.enter);
      expect(select.options.map((option) => option.value)).toEqual(["docs", "projects"]);

      const buttonIds = (payload.components ?? [])
        .flatMap((row) => row.components)
        .flatMap((component) => ("custom_id" in component ? [component.custom_id] : []));
      expect(buttonIds).toEqual(expect.arrayContaining([
        CWD_PICKER_IDS.up,
        CWD_PICKER_IDS.home,
        CWD_PICKER_IDS.confirm,
        CWD_PICKER_IDS.cancel,
      ]));

      const state = parseCwdPickerState(payload.content);
      expect(state).toEqual({ path: tempRoot, page: 1, name: null, prompt: null });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("paginates large directories and clamps the requested page", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cwd-picker-pages-"));

    try {
      for (let index = 0; index < 25; index += 1) {
        await mkdir(path.join(tempRoot, `dir-${String(index).padStart(2, "0")}`));
      }

      const secondPage = await buildCwdPickerPayload({ path: tempRoot, page: 2 });
      expect(secondPage.content).toContain("하위 폴더 25개 · 페이지 2/2");
      const select = secondPage.components?.[0]?.components?.[0] as DiscordSelectMenuPayload;
      expect(select.options).toHaveLength(5);
      expect(parseCwdPickerState(secondPage.content)).toEqual({ path: tempRoot, page: 2, name: null, prompt: null });

      const clamped = await buildCwdPickerPayload({ path: tempRoot, page: 99 });
      expect(clamped.content).toContain("페이지 2/2");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("carries the requested name and prompt through navigation state", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cwd-picker-opts-"));

    try {
      await mkdir(path.join(tempRoot, "projects"));

      const payload = await buildCwdPickerPayload({
        path: tempRoot,
        name: "모찌 프로젝트",
        prompt: "레포 구조를 먼저 훑어줘.\n그 다음 계획을 세워줘.",
      });
      expect(payload.content).toContain("이름: 모찌 프로젝트");

      const state = parseCwdPickerState(payload.content);
      expect(state).toEqual({
        path: tempRoot,
        page: 1,
        name: "모찌 프로젝트",
        prompt: "레포 구조를 먼저 훑어줘.\n그 다음 계획을 세워줘.",
      });

      // Navigation rebuilds must keep the options intact.
      const rebuilt = await buildCwdPickerPayload({
        path: tempRoot,
        page: 1,
        name: state?.name,
        prompt: state?.prompt,
      });
      expect(parseCwdPickerState(rebuilt.content)?.name).toBe("모찌 프로젝트");

      const oversized = await buildCwdPickerPayload({
        path: tempRoot,
        name: "이름은 유지",
        prompt: "긴 프롬프트 ".repeat(400),
      });
      expect(oversized.content).toContain("첫 프롬프트가 너무 길어 제외했습니다");
      const oversizedState = parseCwdPickerState(oversized.content);
      expect(oversizedState?.name).toBe("이름은 유지");
      expect(oversizedState?.prompt).toBeNull();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps navigation paths safe and recognizable", () => {
    expect(isCwdPickerComponent(CWD_PICKER_IDS.confirm)).toBe(true);
    expect(isCwdPickerComponent("cdc:fs:up")).toBe(false);

    expect(cwdPickerParentPath("/tmp/a/b")).toBe("/tmp/a");
    expect(cwdPickerChildPath("/tmp/a", "b")).toBe("/tmp/a/b");
    // Traversal tokens in a select value must not escape the current folder.
    expect(cwdPickerChildPath("/tmp/a", "..")).toBe("/tmp/a");
    expect(cwdPickerChildPath("/tmp/a", "x/../..")).toBe("/tmp/a");

    expect(parseCwdPickerState("아무 관련 없는 메시지")).toBeNull();
  });
});
