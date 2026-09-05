import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  claudeHarnessPluginManifest,
  HARNESS_INTERVIEW_SECTION_KEYS,
  HARNESS_MIN_INTERVIEW_TURNS,
  harnessInterviewCoverage,
  harnessManifestYaml,
  validateHarnessCandidate,
  validateHarnessInterviewBrief,
  type HarnessInterviewBrief,
  type HarnessInterviewPhase,
  type HarnessManifest,
  type HarnessProvider,
  type HarnessSourceMode,
  type HarnessWorkerBinding,
  type ValidatedHarnessCandidate,
} from "../../../packages/core/src/index.js";
import type { HarnessProgressState } from "./harnessProgress.js";

export type HarnessBuildStatus =
  | "drafting"
  | "candidate"
  | "validated"
  | "published"
  | "failed"
  | "cancelled";

export interface HarnessBuildState {
  buildId: string;
  status: HarnessBuildStatus;
  provider: HarnessProvider;
  sourceMode: HarnessSourceMode;
  goal: string | null;
  sourceDiscordChannelId: string | null;
  sourceAgentSessionId: string | null;
  builderDiscordChannelId: string;
  builderAgentSessionId: string | null;
  interviewTurnCount: number;
  interviewPhase: HarnessInterviewPhase | null;
  interviewBrief: HarnessInterviewBrief | null;
  reviewedInterviewDigest: string | null;
  candidateInterviewDigest: string | null;
  candidateDigest: string | null;
  candidateManifest: HarnessManifest | null;
  createdAt: string;
  updatedAt: string;
  publishedVersionId: string | null;
  error: string | null;
}

export interface PublishedHarnessVersionState {
  harnessId: string;
  harnessVersionId: string;
  version: string;
  snapshotDigest: string;
  snapshotPath: string;
  manifest: HarnessManifest;
  sourceBuildId: string;
  publishedAt: string;
}

export type HarnessRunStatus = "provisioning" | "ready" | "running" | "failed" | "interrupted";

export interface HarnessRunState {
  runId: string;
  status: HarnessRunStatus;
  provider: HarnessProvider;
  harnessId: string;
  harnessVersionId: string;
  snapshotDigest: string;
  snapshotPath: string;
  skillName: string;
  sourceMode: HarnessSourceMode;
  sourceDiscordChannelId: string | null;
  sourceAgentSessionId: string | null;
  executionDiscordChannelId: string;
  executionAgentSessionId: string | null;
  requestId: string | null;
  workerJobId: string | null;
  progressMessageId: string | null;
  resultMessageId: string | null;
  progress: HarnessProgressState | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export type HarnessChannelBinding =
  | { kind: "builder"; buildId: string }
  | { kind: "run"; runId: string };

export interface HarnessState {
  version: 2;
  builds: HarnessBuildState[];
  published: PublishedHarnessVersionState[];
  runs: HarnessRunState[];
  channelBindings: Record<string, HarnessChannelBinding>;
}

export interface HarnessStore {
  readonly rootPath: string;
  read(): Promise<HarnessState>;
  createBuild(input: {
    provider: HarnessProvider;
    sourceMode: HarnessSourceMode;
    goal?: string | null;
    sourceDiscordChannelId?: string | null;
    sourceAgentSessionId?: string | null;
    builderDiscordChannelId: string;
  }): Promise<HarnessBuildState>;
  bindBuilderSession(buildId: string, sessionId: string): Promise<HarnessBuildState>;
  buildForChannel(channelId: string): Promise<HarnessBuildState | null>;
  recordInterview(
    buildId: string,
    brief: HarnessInterviewBrief,
    options?: { countTurn?: boolean },
  ): Promise<HarnessBuildState>;
  recordInterviewError(buildId: string, error: string): Promise<HarnessBuildState>;
  saveCandidate(
    buildId: string,
    candidate: ValidatedHarnessCandidate,
    interviewDigest: string,
  ): Promise<HarnessBuildState>;
  recordCandidateError(buildId: string, error: string): Promise<HarnessBuildState>;
  cloneBuildCandidate(sourceBuildId: string, targetBuildId: string): Promise<HarnessBuildState>;
  publishBuild(buildId: string): Promise<PublishedHarnessVersionState>;
  cancelBuild(buildId: string, error?: string | null): Promise<void>;
  listPublished(): Promise<PublishedHarnessVersionState[]>;
  resolvePublished(harnessId: string, version?: string | null): Promise<PublishedHarnessVersionState | null>;
  createRun(input: {
    provider: HarnessProvider;
    published: PublishedHarnessVersionState;
    sourceMode: HarnessSourceMode;
    sourceDiscordChannelId?: string | null;
    sourceAgentSessionId?: string | null;
    executionDiscordChannelId: string;
    requestId?: string | null;
  }): Promise<HarnessRunState>;
  bindRunSession(runId: string, sessionId: string): Promise<HarnessRunState>;
  runForChannel(channelId: string): Promise<HarnessRunState | null>;
  runForRequest(requestId: string): Promise<HarnessRunState | null>;
  updateRunExecution(
    runId: string,
    patch: Partial<Pick<HarnessRunState, "workerJobId" | "progressMessageId" | "resultMessageId" | "progress">>,
  ): Promise<HarnessRunState>;
  markRunStatus(runId: string, status: HarnessRunStatus, error?: string | null): Promise<void>;
  removeChannelBinding(channelId: string): Promise<boolean>;
  workerBinding(run: HarnessRunState): HarnessWorkerBinding;
}

function emptyState(): HarnessState {
  return { version: 2, builds: [], published: [], runs: [], channelBindings: {} };
}

function normalizeBuild(value: HarnessBuildState): HarnessBuildState {
  let brief: HarnessInterviewBrief | null = null;
  try {
    brief = value.interviewBrief
      ? validateHarnessInterviewBrief(value.interviewBrief)
      : null;
  } catch {
    brief = null;
  }
  return {
    ...value,
    interviewTurnCount: Number.isInteger(value.interviewTurnCount) && value.interviewTurnCount >= 0
      ? value.interviewTurnCount
      : 0,
    interviewPhase: brief?.phase ?? null,
    interviewBrief: brief,
    reviewedInterviewDigest: typeof value.reviewedInterviewDigest === "string"
      ? value.reviewedInterviewDigest
      : null,
    candidateInterviewDigest: typeof value.candidateInterviewDigest === "string"
      ? value.candidateInterviewDigest
      : null,
  };
}

function normalizeRun(value: HarnessRunState): HarnessRunState {
  return {
    ...value,
    requestId: typeof value.requestId === "string" && value.requestId.trim()
      ? value.requestId.trim()
      : null,
    workerJobId: typeof value.workerJobId === "string" && value.workerJobId.trim()
      ? value.workerJobId.trim()
      : null,
    progressMessageId: typeof value.progressMessageId === "string" && value.progressMessageId.trim()
      ? value.progressMessageId.trim()
      : null,
    resultMessageId: typeof value.resultMessageId === "string" && value.resultMessageId.trim()
      ? value.resultMessageId.trim()
      : null,
    progress: typeof value.progress === "object" && value.progress !== null
      ? value.progress
      : null,
  };
}

function normalizeState(value: unknown): HarnessState {
  if (!value || typeof value !== "object") {
    return emptyState();
  }
  const state = value as Partial<HarnessState>;
  const bindings = state.channelBindings && typeof state.channelBindings === "object"
    ? state.channelBindings
    : {};
  return {
    version: 2,
    builds: Array.isArray(state.builds) ? state.builds.map(normalizeBuild) : [],
    published: Array.isArray(state.published) ? state.published : [],
    runs: Array.isArray(state.runs) ? state.runs.map(normalizeRun) : [],
    channelBindings: bindings,
  };
}

export function defaultHarnessRootPath(): string {
  const statePath = path.resolve(process.env.CONNECT_STATE_PATH ?? ".connect/state.json");
  return path.resolve(process.env.CONNECT_HARNESS_ROOT ?? path.join(path.dirname(statePath), "harnesses"));
}

function materializedPath(candidatePath: string): string {
  if (candidatePath === "SKILL.md") {
    return "skill/SKILL.md";
  }
  if (candidatePath.startsWith("agents/")) {
    return candidatePath;
  }
  return `skill/${candidatePath}`;
}

async function writeSecureFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(filePath), 0o700);
  await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function materializeSnapshot(input: {
  destination: string;
  candidate: ValidatedHarnessCandidate;
  harnessVersionId?: string | null;
  includeCandidate?: boolean;
}): Promise<void> {
  const staging = `${input.destination}.next.${process.pid}.${randomUUID()}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });

  try {
    for (const file of input.candidate.files) {
      await writeSecureFile(path.join(staging, materializedPath(file.path)), file.content);
    }
    await writeSecureFile(
      path.join(staging, "harness.yaml"),
      harnessManifestYaml(input.candidate.manifest),
    );
    await writeSecureFile(
      path.join(staging, ".claude-plugin", "plugin.json"),
      claudeHarnessPluginManifest(input.candidate.manifest),
    );
    await writeSecureFile(
      path.join(staging, "snapshot.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        harnessVersionId: input.harnessVersionId ?? null,
        digest: input.candidate.digest,
        manifest: input.candidate.manifest,
        files: input.candidate.files,
      }, null, 2)}\n`,
    );
    if (input.includeCandidate) {
      await writeSecureFile(
        path.join(staging, "candidate.json"),
        `${JSON.stringify({
          manifest: input.candidate.manifest,
          files: input.candidate.files,
        }, null, 2)}\n`,
      );
    }

    await rm(input.destination, { recursive: true, force: true });
    await rename(staging, input.destination);
    await chmod(input.destination, 0o700);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readCandidate(candidatePath: string): Promise<ValidatedHarnessCandidate> {
  const parsed = JSON.parse(await readFile(path.join(candidatePath, "candidate.json"), "utf8")) as unknown;
  return validateHarnessCandidate(parsed);
}

async function directoryIsMaterialized(directory: string): Promise<boolean> {
  return lstat(path.join(directory, "snapshot.json")).then((entry) => entry.isFile()).catch(() => false);
}

function interviewTransitionAllowed(
  previous: HarnessInterviewPhase | null,
  next: HarnessInterviewPhase,
): boolean {
  if (!previous) {
    return next === "discovery" || next === "design";
  }
  if (previous === "discovery") {
    return next === "discovery" || next === "design";
  }
  if (previous === "design") {
    return next === "design" || next === "review";
  }
  return next === "design" || next === "review" || next === "ready";
}

export function createHarnessStore(rootPath = defaultHarnessRootPath()): HarnessStore {
  const resolvedRoot = path.resolve(rootPath);
  const statePath = path.join(resolvedRoot, "state.json");
  let mutationQueue: Promise<void> = Promise.resolve();

  async function readState(): Promise<HarnessState> {
    try {
      return normalizeState(JSON.parse(await readFile(statePath, "utf8")) as unknown);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
  }

  async function writeState(state: HarnessState): Promise<void> {
    await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
    await chmod(resolvedRoot, 0o700);
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(normalizeState(state), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, statePath);
      await chmod(statePath, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  function mutate<T>(mutator: (state: HarnessState) => Promise<T> | T): Promise<T> {
    const operation = mutationQueue.then(async () => {
      const state = await readState();
      const result = await mutator(state);
      await writeState(state);
      return result;
    });
    mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  const store: HarnessStore = {
    rootPath: resolvedRoot,
    async read() {
      await mutationQueue;
      return readState();
    },
    async createBuild(input) {
      return mutate((state) => {
        if (state.channelBindings[input.builderDiscordChannelId]) {
          throw new Error("이 Discord 스레드는 이미 다른 하네스 작업에 연결되어 있습니다.");
        }
        const now = new Date().toISOString();
        const build: HarnessBuildState = {
          buildId: randomUUID(),
          status: "drafting",
          provider: input.provider,
          sourceMode: input.sourceMode,
          goal: input.goal?.trim() || null,
          sourceDiscordChannelId: input.sourceDiscordChannelId?.trim() || null,
          sourceAgentSessionId: input.sourceAgentSessionId?.trim() || null,
          builderDiscordChannelId: input.builderDiscordChannelId,
          builderAgentSessionId: null,
          interviewTurnCount: 0,
          interviewPhase: null,
          interviewBrief: null,
          reviewedInterviewDigest: null,
          candidateInterviewDigest: null,
          candidateDigest: null,
          candidateManifest: null,
          createdAt: now,
          updatedAt: now,
          publishedVersionId: null,
          error: null,
        };
        state.builds.push(build);
        state.channelBindings[input.builderDiscordChannelId] = { kind: "builder", buildId: build.buildId };
        return build;
      });
    },
    async bindBuilderSession(buildId, sessionId) {
      return mutate((state) => {
        const build = state.builds.find((candidate) => candidate.buildId === buildId);
        if (!build) {
          throw new Error(`하네스 build를 찾을 수 없습니다: ${buildId}`);
        }
        const normalized = sessionId.trim();
        if (!normalized) {
          throw new Error("Builder agent session ID가 비어 있습니다.");
        }
        if (build.builderAgentSessionId && build.builderAgentSessionId.toLowerCase() !== normalized.toLowerCase()) {
          throw new Error("Builder Discord 스레드가 다른 agent session으로 바뀌어 작업을 중단했습니다.");
        }
        build.builderAgentSessionId = normalized;
        build.updatedAt = new Date().toISOString();
        return build;
      });
    },
    async buildForChannel(channelId) {
      const state = await store.read();
      const binding = state.channelBindings[channelId];
      return binding?.kind === "builder"
        ? state.builds.find((build) => build.buildId === binding.buildId) ?? null
        : null;
    },
    async recordInterview(buildId, brief, options = {}) {
      const validatedBrief = validateHarnessInterviewBrief(brief);
      return mutate((state) => {
        const build = state.builds.find((entry) => entry.buildId === buildId);
        if (!build) {
          throw new Error(`하네스 build를 찾을 수 없습니다: ${buildId}`);
        }
        if (build.status === "published" || build.status === "cancelled") {
          throw new Error(`현재 build 상태(${build.status})에서는 설계를 바꿀 수 없습니다.`);
        }
        if (!interviewTransitionAllowed(build.interviewPhase, validatedBrief.phase)) {
          throw new Error(
            `설계 단계가 ${build.interviewPhase ?? "start"}에서 ${validatedBrief.phase}(으)로 너무 빨리 이동했습니다.`,
          );
        }

        const nextTurnCount = build.interviewTurnCount + (options.countTurn === false ? 0 : 1);
        if (validatedBrief.phase === "review" && nextTurnCount < HARNESS_MIN_INTERVIEW_TURNS - 1) {
          throw new Error(
            `설계 요약 전에 최소 ${HARNESS_MIN_INTERVIEW_TURNS - 1}회의 Builder 응답이 필요합니다.`,
          );
        }
        if (validatedBrief.phase === "ready") {
          if (nextTurnCount < HARNESS_MIN_INTERVIEW_TURNS) {
            throw new Error(
              `하네스 후보 생성 전에 최소 ${HARNESS_MIN_INTERVIEW_TURNS}회의 Builder 응답이 필요합니다.`,
            );
          }
          const retryingSameReadyBrief = options.countTurn === false &&
            build.interviewPhase === "ready" &&
            build.interviewBrief?.digest === validatedBrief.digest &&
            build.reviewedInterviewDigest === validatedBrief.digest;
          if (
            !retryingSameReadyBrief &&
            (build.interviewPhase !== "review" || !build.reviewedInterviewDigest)
          ) {
            throw new Error("사용자에게 완성된 설계 요약을 먼저 보여주고 다음 답변에서 확인받아야 합니다.");
          }
          if (validatedBrief.digest !== build.reviewedInterviewDigest) {
            throw new Error("사용자가 확인한 설계 요약이 변경되었습니다. 변경된 요약을 다시 보여주고 확인받으세요.");
          }
        }

        const invalidatesCandidate = validatedBrief.phase !== "ready" ||
          build.candidateInterviewDigest !== validatedBrief.digest;
        if (invalidatesCandidate) {
          build.candidateDigest = null;
          build.candidateManifest = null;
          build.candidateInterviewDigest = null;
          build.publishedVersionId = null;
        }
        build.interviewTurnCount = nextTurnCount;
        build.interviewPhase = validatedBrief.phase;
        build.interviewBrief = validatedBrief;
        if (validatedBrief.phase === "review") {
          build.reviewedInterviewDigest = validatedBrief.digest;
        } else if (validatedBrief.phase === "discovery" || validatedBrief.phase === "design") {
          build.reviewedInterviewDigest = null;
        }
        build.status = build.candidateDigest ? "validated" : "drafting";
        build.error = null;
        build.updatedAt = new Date().toISOString();
        return build;
      });
    },
    async recordInterviewError(buildId, error) {
      return mutate((state) => {
        const build = state.builds.find((entry) => entry.buildId === buildId);
        if (!build) {
          throw new Error(`하네스 build를 찾을 수 없습니다: ${buildId}`);
        }
        if (build.status === "published" || build.status === "cancelled") {
          throw new Error(`현재 build 상태(${build.status})에서는 설계를 바꿀 수 없습니다.`);
        }
        build.status = "drafting";
        build.candidateDigest = null;
        build.candidateManifest = null;
        build.candidateInterviewDigest = null;
        build.error = error.trim() || "하네스 설계 브리프 검증에 실패했습니다.";
        build.updatedAt = new Date().toISOString();
        return build;
      });
    },
    async saveCandidate(buildId, candidate, interviewDigest) {
      const build = (await store.read()).builds.find((entry) => entry.buildId === buildId);
      if (!build) {
        throw new Error(`하네스 build를 찾을 수 없습니다: ${buildId}`);
      }
      if (build.status === "published" || build.status === "cancelled") {
        throw new Error(`현재 build 상태(${build.status})에서는 후보를 바꿀 수 없습니다.`);
      }
      if (
        build.interviewPhase !== "ready" ||
        !build.interviewBrief?.userConfirmed ||
        harnessInterviewCoverage(build.interviewBrief) !== HARNESS_INTERVIEW_SECTION_KEYS.length ||
        build.interviewTurnCount < HARNESS_MIN_INTERVIEW_TURNS ||
        !build.reviewedInterviewDigest ||
        interviewDigest !== build.reviewedInterviewDigest
      ) {
        throw new Error("상세 설계 문답과 사용자 확인을 마치기 전에는 하네스 후보를 저장할 수 없습니다.");
      }
      const draftPath = path.join(resolvedRoot, "drafts", buildId, "candidate");
      await materializeSnapshot({
        destination: draftPath,
        candidate,
        includeCandidate: true,
      });
      return mutate((state) => {
        const current = state.builds.find((entry) => entry.buildId === buildId);
        if (!current || current.status === "published" || current.status === "cancelled") {
          throw new Error("하네스 build 상태가 후보 저장 중 변경되었습니다.");
        }
        if (
          current.interviewPhase !== "ready" ||
          current.reviewedInterviewDigest !== interviewDigest ||
          current.interviewBrief?.digest !== interviewDigest
        ) {
          throw new Error("설계 브리프가 후보 저장 중 변경되었습니다.");
        }
        current.status = "validated";
        current.candidateDigest = candidate.digest;
        current.candidateManifest = candidate.manifest;
        current.candidateInterviewDigest = interviewDigest;
        current.error = null;
        current.updatedAt = new Date().toISOString();
        return current;
      });
    },
    async recordCandidateError(buildId, error) {
      return mutate((state) => {
        const build = state.builds.find((entry) => entry.buildId === buildId);
        if (!build) {
          throw new Error(`하네스 build를 찾을 수 없습니다: ${buildId}`);
        }
        if (build.status === "published" || build.status === "cancelled") {
          throw new Error(`현재 build 상태(${build.status})에서는 후보를 바꿀 수 없습니다.`);
        }
        build.status = "candidate";
        build.candidateDigest = null;
        build.candidateManifest = null;
        build.candidateInterviewDigest = null;
        build.error = error.trim() || "하네스 후보 검증에 실패했습니다.";
        build.updatedAt = new Date().toISOString();
        return build;
      });
    },
    async cloneBuildCandidate(sourceBuildId, targetBuildId) {
      const state = await store.read();
      const source = state.builds.find((entry) => entry.buildId === sourceBuildId);
      const target = state.builds.find((entry) => entry.buildId === targetBuildId);
      if (!source || !target) {
        throw new Error("복제할 Harness Builder 상태를 찾을 수 없습니다.");
      }
      const cloned = await mutate((currentState) => {
        const currentTarget = currentState.builds.find((entry) => entry.buildId === targetBuildId);
        if (!currentTarget) {
          throw new Error("복제 대상 Harness Builder 상태를 찾을 수 없습니다.");
        }
        currentTarget.interviewTurnCount = source.interviewTurnCount;
        currentTarget.interviewPhase = source.interviewPhase;
        currentTarget.interviewBrief = source.interviewBrief;
        currentTarget.reviewedInterviewDigest = source.reviewedInterviewDigest;
        currentTarget.updatedAt = new Date().toISOString();
        return currentTarget;
      });
      if (!source.candidateDigest || !source.candidateInterviewDigest) {
        return cloned;
      }
      const candidate = await readCandidate(path.join(resolvedRoot, "drafts", sourceBuildId, "candidate"));
      if (candidate.digest !== source.candidateDigest) {
        throw new Error("원본 Harness Builder 후보 digest가 상태와 일치하지 않습니다.");
      }
      return store.saveCandidate(targetBuildId, candidate, source.candidateInterviewDigest);
    },
    async publishBuild(buildId) {
      const before = (await store.read()).builds.find((entry) => entry.buildId === buildId);
      if (
        !before ||
        before.status !== "validated" ||
        !before.candidateDigest ||
        !before.candidateManifest ||
        !before.candidateInterviewDigest ||
        before.candidateInterviewDigest !== before.reviewedInterviewDigest ||
        before.interviewPhase !== "ready" ||
        !before.interviewBrief?.userConfirmed
      ) {
        throw new Error("검증된 하네스 후보가 없습니다. Builder와 문답을 마친 뒤 다시 시도하세요.");
      }
      const candidate = await readCandidate(path.join(resolvedRoot, "drafts", buildId, "candidate"));
      if (candidate.digest !== before.candidateDigest) {
        throw new Error("저장된 하네스 후보 digest가 상태와 일치하지 않습니다.");
      }
      const existing = (await store.read()).published.find(
        (entry) => entry.harnessId === candidate.manifest.id && entry.version === candidate.manifest.version,
      );
      if (existing) {
        if (existing.snapshotDigest !== candidate.digest) {
          throw new Error(
            `${candidate.manifest.id} ${candidate.manifest.version}은 이미 다른 내용으로 발행되었습니다. version을 올려 주세요.`,
          );
        }
        await mutate((state) => {
          const current = state.builds.find((entry) => entry.buildId === buildId);
          if (!current) {
            throw new Error("하네스 build가 발행 중 사라졌습니다.");
          }
          if (
            current.status !== "validated" ||
            current.candidateDigest !== candidate.digest ||
            current.candidateInterviewDigest !== before.candidateInterviewDigest
          ) {
            throw new Error("하네스 후보가 발행 도중 변경되었습니다. 최신 후보를 다시 확인하세요.");
          }
          current.status = "published";
          current.publishedVersionId = existing.harnessVersionId;
          current.updatedAt = new Date().toISOString();
        });
        return existing;
      }

      const harnessVersionId = `${candidate.manifest.id}@${candidate.manifest.version}#${candidate.digest.slice(0, 12)}`;
      const snapshotPath = path.join(
        resolvedRoot,
        "published",
        candidate.manifest.id,
        `${candidate.manifest.version}-${candidate.digest.slice(0, 12)}`,
      );
      if (!(await directoryIsMaterialized(snapshotPath))) {
        await materializeSnapshot({ destination: snapshotPath, candidate, harnessVersionId });
      }
      return mutate((state) => {
        const current = state.builds.find((entry) => entry.buildId === buildId);
        if (!current) {
          throw new Error("하네스 build가 발행 중 사라졌습니다.");
        }
        if (
          current.status !== "validated" ||
          current.candidateDigest !== candidate.digest ||
          current.candidateInterviewDigest !== before.candidateInterviewDigest
        ) {
          throw new Error("하네스 후보가 발행 도중 변경되었습니다. 최신 후보를 다시 확인하세요.");
        }
        const already = state.published.find(
          (entry) => entry.harnessId === candidate.manifest.id && entry.version === candidate.manifest.version,
        );
        if (already) {
          if (already.snapshotDigest !== candidate.digest) {
            throw new Error(
              `${candidate.manifest.id} ${candidate.manifest.version}은 발행 도중 다른 내용으로 먼저 등록되었습니다. version을 올려 주세요.`,
            );
          }
          current.status = "published";
          current.publishedVersionId = already.harnessVersionId;
          current.updatedAt = new Date().toISOString();
          return already;
        }
        const published: PublishedHarnessVersionState = {
          harnessId: candidate.manifest.id,
          harnessVersionId,
          version: candidate.manifest.version,
          snapshotDigest: candidate.digest,
          snapshotPath,
          manifest: candidate.manifest,
          sourceBuildId: buildId,
          publishedAt: new Date().toISOString(),
        };
        state.published.push(published);
        current.status = "published";
        current.publishedVersionId = harnessVersionId;
        current.updatedAt = published.publishedAt;
        return published;
      });
    },
    async cancelBuild(buildId, error) {
      await mutate((state) => {
        const build = state.builds.find((entry) => entry.buildId === buildId);
        if (!build) {
          return;
        }
        build.status = error ? "failed" : "cancelled";
        build.error = error?.trim() || null;
        build.updatedAt = new Date().toISOString();
        if (state.channelBindings[build.builderDiscordChannelId]?.kind === "builder") {
          delete state.channelBindings[build.builderDiscordChannelId];
        }
      });
    },
    async listPublished() {
      return (await store.read()).published
        .slice()
        .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
    },
    async resolvePublished(harnessId, version) {
      const normalizedId = harnessId.trim().toLowerCase();
      const normalizedVersion = version?.trim() || null;
      const matches = (await store.read()).published
        .filter((entry) => entry.harnessId === normalizedId && (!normalizedVersion || entry.version === normalizedVersion))
        .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
      return matches[0] ?? null;
    },
    async createRun(input) {
      return mutate((state) => {
        if (state.channelBindings[input.executionDiscordChannelId]) {
          throw new Error("실행 Discord 스레드는 이미 다른 하네스에 연결되어 있습니다.");
        }
        const now = new Date().toISOString();
        const run: HarnessRunState = {
          runId: randomUUID(),
          status: "provisioning",
          provider: input.provider,
          harnessId: input.published.harnessId,
          harnessVersionId: input.published.harnessVersionId,
          snapshotDigest: input.published.snapshotDigest,
          snapshotPath: input.published.snapshotPath,
          skillName: input.published.manifest.name,
          sourceMode: input.sourceMode,
          sourceDiscordChannelId: input.sourceDiscordChannelId?.trim() || null,
          sourceAgentSessionId: input.sourceAgentSessionId?.trim() || null,
          executionDiscordChannelId: input.executionDiscordChannelId,
          executionAgentSessionId: null,
          requestId: input.requestId?.trim() || null,
          workerJobId: input.requestId?.trim() || null,
          progressMessageId: null,
          resultMessageId: null,
          progress: null,
          createdAt: now,
          updatedAt: now,
          error: null,
        };
        state.runs.push(run);
        state.channelBindings[input.executionDiscordChannelId] = { kind: "run", runId: run.runId };
        return run;
      });
    },
    async bindRunSession(runId, sessionId) {
      return mutate((state) => {
        const run = state.runs.find((entry) => entry.runId === runId);
        if (!run) {
          throw new Error(`하네스 run을 찾을 수 없습니다: ${runId}`);
        }
        const normalized = sessionId.trim();
        if (!normalized) {
          throw new Error("Execution agent session ID가 비어 있습니다.");
        }
        if (run.executionAgentSessionId && run.executionAgentSessionId.toLowerCase() !== normalized.toLowerCase()) {
          throw new Error("Execution Discord 스레드가 다른 agent session으로 바뀌어 실행을 중단했습니다.");
        }
        run.executionAgentSessionId = normalized;
        if (run.status === "provisioning") {
          run.status = "ready";
        }
        run.updatedAt = new Date().toISOString();
        return run;
      });
    },
    async runForChannel(channelId) {
      const state = await store.read();
      const binding = state.channelBindings[channelId];
      return binding?.kind === "run"
        ? state.runs.find((run) => run.runId === binding.runId) ?? null
        : null;
    },
    async runForRequest(requestId) {
      const normalized = requestId.trim();
      if (!normalized) {
        return null;
      }
      const state = await store.read();
      return state.runs.find((run) => run.requestId === normalized) ?? null;
    },
    async updateRunExecution(runId, patch) {
      return mutate((state) => {
        const run = state.runs.find((entry) => entry.runId === runId);
        if (!run) {
          throw new Error(`하네스 run을 찾을 수 없습니다: ${runId}`);
        }
        for (const key of ["workerJobId", "progressMessageId", "resultMessageId"] as const) {
          if (!(key in patch)) {
            continue;
          }
          const value = patch[key];
          run[key] = typeof value === "string" && value.trim() ? value.trim() : null;
        }
        if ("progress" in patch) {
          run.progress = patch.progress ?? null;
        }
        run.updatedAt = new Date().toISOString();
        return run;
      });
    },
    async markRunStatus(runId, status, error) {
      await mutate((state) => {
        const run = state.runs.find((entry) => entry.runId === runId);
        if (!run) {
          return;
        }
        run.status = status;
        run.error = error?.trim() || null;
        run.updatedAt = new Date().toISOString();
      });
    },
    async removeChannelBinding(channelId) {
      return mutate((state) => {
        if (!state.channelBindings[channelId]) {
          return false;
        }
        delete state.channelBindings[channelId];
        return true;
      });
    },
    workerBinding(run) {
      return {
        schemaVersion: 1,
        harnessId: run.harnessId,
        harnessVersionId: run.harnessVersionId,
        snapshotDigest: run.snapshotDigest,
        runId: run.runId,
        snapshotPath: run.snapshotPath,
        skillName: run.skillName,
      };
    },
  };

  return store;
}
