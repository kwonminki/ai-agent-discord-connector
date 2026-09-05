import { createHash } from "node:crypto";

export const HARNESS_CANDIDATE_FENCE = "codex-discord-harness";
export const HARNESS_INTERVIEW_FENCE = "codex-discord-harness-brief";
export const HARNESS_SCHEMA_VERSION = 1 as const;
export const HARNESS_INTERVIEW_SCHEMA_VERSION = 1 as const;
export const HARNESS_MIN_INTERVIEW_TURNS = 4;
export const HARNESS_MAX_FILES = 32;
export const HARNESS_MAX_FILE_BYTES = 128 * 1024;
export const HARNESS_MAX_TOTAL_BYTES = 512 * 1024;

export type HarnessProvider = "codex" | "claude";
export type HarnessSourceMode = "current" | "fresh";
export type HarnessInterviewPhase = "discovery" | "design" | "review" | "ready";

export const HARNESS_INTERVIEW_SECTION_KEYS = [
  "purposeAndTriggers",
  "usageExamples",
  "inputsAndContext",
  "workflowAndDecisions",
  "outputsAndSuccess",
  "constraintsAndPermissions",
  "resourcesAndRoles",
  "failuresAndEscalation",
  "validationCases",
] as const;

export type HarnessInterviewSectionKey = typeof HARNESS_INTERVIEW_SECTION_KEYS[number];

export interface HarnessInterviewBrief {
  schemaVersion: typeof HARNESS_INTERVIEW_SCHEMA_VERSION;
  phase: HarnessInterviewPhase;
  sections: Record<HarnessInterviewSectionKey, string | null>;
  openQuestions: string[];
  userConfirmed: boolean;
  digest: string;
}

export interface HarnessInterviewExtraction {
  brief: HarnessInterviewBrief | null;
  error: string | null;
}

export interface HarnessManifest {
  schemaVersion: typeof HARNESS_SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  version: string;
  providers: HarnessProvider[];
  maxSubagents: number;
  outputs: string[];
}

export interface HarnessCandidateFile {
  path: string;
  content: string;
}

export interface ValidatedHarnessCandidate {
  manifest: HarnessManifest;
  files: HarnessCandidateFile[];
  digest: string;
}

export interface HarnessWorkerBinding {
  schemaVersion: typeof HARNESS_SCHEMA_VERSION;
  harnessId: string;
  harnessVersionId: string;
  snapshotDigest: string;
  runId: string;
  snapshotPath: string;
  skillName: string;
}

export interface HarnessCandidateExtraction {
  candidate: ValidatedHarnessCandidate | null;
  error: string | null;
}

const HARNESS_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ALLOWED_FILE_PATH = /^(?:SKILL\.md|(?:agents|references|tests|assets)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,179})$/;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalInterviewSections(
  sections: Record<HarnessInterviewSectionKey, string | null>,
): string {
  return JSON.stringify(Object.fromEntries(
    HARNESS_INTERVIEW_SECTION_KEYS.map((key) => [key, sections[key]]),
  ));
}

export function harnessInterviewDigest(
  sections: Record<HarnessInterviewSectionKey, string | null>,
): string {
  return createHash("sha256").update(canonicalInterviewSections(sections), "utf8").digest("hex");
}

export function harnessInterviewCoverage(brief: HarnessInterviewBrief | null): number {
  return brief
    ? HARNESS_INTERVIEW_SECTION_KEYS.filter((key) => Boolean(brief.sections[key]?.trim())).length
    : 0;
}

export function validateHarnessInterviewBrief(value: unknown): HarnessInterviewBrief {
  if (!isRecord(value) || !isRecord(value.sections)) {
    throw new Error("설계 브리프에는 phase와 sections 객체가 필요합니다.");
  }
  const rawSections = value.sections;

  const errors: string[] = [];
  const phase = normalizedString(value.phase) as HarnessInterviewPhase;
  if (!["discovery", "design", "review", "ready"].includes(phase)) {
    errors.push("설계 브리프 phase는 discovery, design, review, ready 중 하나여야 합니다.");
  }
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== HARNESS_INTERVIEW_SCHEMA_VERSION
  ) {
    errors.push(`지원하지 않는 설계 브리프 schemaVersion입니다: ${String(value.schemaVersion)}`);
  }

  const rawSectionKeys = Object.keys(rawSections);
  for (const key of rawSectionKeys) {
    if (!(HARNESS_INTERVIEW_SECTION_KEYS as readonly string[]).includes(key)) {
      errors.push(`알 수 없는 설계 브리프 section입니다: ${key}`);
    }
  }
  const sections = Object.fromEntries(HARNESS_INTERVIEW_SECTION_KEYS.map((key) => {
    const raw = rawSections[key];
    if (raw !== null && raw !== undefined && typeof raw !== "string") {
      errors.push(`${key} section은 문자열 또는 null이어야 합니다.`);
    }
    const normalized = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (normalized.length > 2_000) {
      errors.push(`${key} section은 2,000자를 넘을 수 없습니다.`);
    }
    return [key, normalized || null];
  })) as Record<HarnessInterviewSectionKey, string | null>;

  const openQuestions = Array.isArray(value.openQuestions)
    ? value.openQuestions
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.replace(/\s+/g, " ").trim())
      .filter(Boolean)
    : [];
  if (
    value.openQuestions !== undefined &&
    (!Array.isArray(value.openQuestions) || value.openQuestions.some(
      (entry) => typeof entry !== "string" || entry.trim().length > 500,
    ))
  ) {
    errors.push("openQuestions는 각각 500자 이하인 문자열 배열이어야 합니다.");
  }
  if (openQuestions.length > 12) {
    errors.push("openQuestions는 최대 12개까지 저장할 수 있습니다.");
  }

  const userConfirmed = value.userConfirmed === true;
  if (value.userConfirmed !== undefined && typeof value.userConfirmed !== "boolean") {
    errors.push("userConfirmed는 boolean이어야 합니다.");
  }
  const coverage = HARNESS_INTERVIEW_SECTION_KEYS.filter((key) => Boolean(sections[key])).length;
  if ((phase === "review" || phase === "ready") && coverage !== HARNESS_INTERVIEW_SECTION_KEYS.length) {
    errors.push("review/ready 단계에는 9개 설계 영역이 모두 채워져야 합니다.");
  }
  if ((phase === "review" || phase === "ready") && openQuestions.length > 0) {
    errors.push("review/ready 단계에는 미해결 질문이 없어야 합니다.");
  }
  if (phase === "ready" && !userConfirmed) {
    errors.push("ready 단계는 사용자가 직전 설계 요약을 명시적으로 확인한 뒤에만 사용할 수 있습니다.");
  }
  if (phase !== "ready" && userConfirmed) {
    errors.push("userConfirmed는 ready 단계에서만 true일 수 있습니다.");
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return {
    schemaVersion: HARNESS_INTERVIEW_SCHEMA_VERSION,
    phase,
    sections,
    openQuestions: [...new Set(openQuestions)],
    userConfirmed,
    digest: harnessInterviewDigest(sections),
  };
}

export function harnessIdFromName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return normalized || "custom-harness";
}

function normalizeProviders(value: unknown): HarnessProvider[] {
  if (!Array.isArray(value)) {
    return ["codex", "claude"];
  }

  const providers = [...new Set(value.filter(
    (entry): entry is HarnessProvider => entry === "codex" || entry === "claude",
  ))];
  return providers.length > 0 ? providers : ["codex", "claude"];
}

function normalizeOutputs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter((entry) => entry.length > 0 && entry.length <= 300))]
    .slice(0, 20);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

export function harnessManifestYaml(manifest: HarnessManifest): string {
  return [
    `schemaVersion: ${manifest.schemaVersion}`,
    `id: ${yamlScalar(manifest.id)}`,
    `name: ${yamlScalar(manifest.name)}`,
    `description: ${yamlScalar(manifest.description)}`,
    `version: ${yamlScalar(manifest.version)}`,
    "providers:",
    ...manifest.providers.map((provider) => `  - ${provider}`),
    `maxSubagents: ${manifest.maxSubagents}`,
    ...(manifest.outputs.length > 0
      ? ["outputs:", ...manifest.outputs.map((output) => `  - ${yamlScalar(output)}`)]
      : ["outputs: []"]),
    "",
  ].join("\n");
}

export function claudeHarnessPluginManifest(manifest: HarnessManifest): string {
  return `${JSON.stringify({
    name: `cdc-${manifest.id}`,
    description: manifest.description,
    version: manifest.version,
    author: { name: "AI Agent Discord Connector" },
    skills: ["./skill"],
  }, null, 2)}\n`;
}

function parseFrontmatter(markdown: string): Record<string, string> | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }

  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!field) {
      return null;
    }
    let value = field[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    fields[field[1] ?? ""] = value.trim();
  }
  return fields;
}

function validateSkill(manifest: HarnessManifest, content: string): string[] {
  const errors: string[] = [];
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) {
    return ["SKILL.md에는 유효한 YAML frontmatter가 필요합니다."];
  }

  const keys = Object.keys(frontmatter);
  if (keys.some((key) => key !== "name" && key !== "description")) {
    errors.push("SKILL.md frontmatter에는 name과 description만 사용할 수 있습니다.");
  }
  if (frontmatter.name !== manifest.name) {
    errors.push(`SKILL.md name은 manifest name(${manifest.name})과 같아야 합니다.`);
  }
  if (!frontmatter.description || frontmatter.description.length < 12) {
    errors.push("SKILL.md description은 사용 시점을 알 수 있도록 12자 이상 작성해야 합니다.");
  }
  if (content.length > 40_000) {
    errors.push("SKILL.md는 40,000자를 넘을 수 없습니다. 세부 자료는 references/로 분리하세요.");
  }
  return errors;
}

function validateAgent(path: string, content: string): string[] {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) {
    return [`${path}에는 유효한 YAML frontmatter가 필요합니다.`];
  }

  const errors: string[] = [];
  if (!HARNESS_ID_PATTERN.test(frontmatter.name ?? "")) {
    errors.push(`${path}의 agent name은 소문자 영문, 숫자, 하이픈만 사용할 수 있습니다.`);
  }
  if (!frontmatter.description || frontmatter.description.length < 12) {
    errors.push(`${path}의 description은 12자 이상이어야 합니다.`);
  }
  for (const forbidden of ["hooks", "mcpServers", "permissionMode"]) {
    if (Object.hasOwn(frontmatter, forbidden)) {
      errors.push(`${path}에는 안전하지 않은 ${forbidden} 설정을 넣을 수 없습니다.`);
    }
  }
  if (/^background:\s*(?:true|yes|on)\s*$/im.test(content)) {
    errors.push(`${path}에는 background agent를 활성화할 수 없습니다.`);
  }
  return errors;
}

function canonicalCandidate(candidate: { manifest: HarnessManifest; files: HarnessCandidateFile[] }): string {
  return JSON.stringify({
    schemaVersion: HARNESS_SCHEMA_VERSION,
    manifest: {
      schemaVersion: candidate.manifest.schemaVersion,
      id: candidate.manifest.id,
      name: candidate.manifest.name,
      description: candidate.manifest.description,
      version: candidate.manifest.version,
      providers: [...candidate.manifest.providers].sort(),
      maxSubagents: candidate.manifest.maxSubagents,
      outputs: candidate.manifest.outputs,
    },
    files: [...candidate.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({ path: file.path, content: file.content })),
  });
}

export function harnessCandidateDigest(candidate: {
  manifest: HarnessManifest;
  files: HarnessCandidateFile[];
}): string {
  return createHash("sha256").update(canonicalCandidate(candidate), "utf8").digest("hex");
}

export function validateHarnessCandidate(value: unknown): ValidatedHarnessCandidate {
  if (!isRecord(value) || !isRecord(value.manifest) || !Array.isArray(value.files)) {
    throw new Error("하네스 후보는 manifest 객체와 files 배열을 포함해야 합니다.");
  }

  const rawManifest = value.manifest;
  const name = normalizedString(rawManifest.name);
  const id = normalizedString(rawManifest.id) || harnessIdFromName(name);
  const description = normalizedString(rawManifest.description);
  const version = normalizedString(rawManifest.version) || "1.0.0";
  const maxSubagentsValue = rawManifest.maxSubagents;
  const maxSubagents = typeof maxSubagentsValue === "number" && Number.isInteger(maxSubagentsValue)
    ? maxSubagentsValue
    : 0;
  const manifest: HarnessManifest = {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id,
    name,
    description,
    version,
    providers: normalizeProviders(rawManifest.providers),
    maxSubagents,
    outputs: normalizeOutputs(rawManifest.outputs),
  };
  const errors: string[] = [];

  if (!HARNESS_ID_PATTERN.test(id)) {
    errors.push("manifest id는 소문자 영문, 숫자, 하이픈으로 된 1~64자여야 합니다.");
  }
  if (WINDOWS_RESERVED_BASENAME.test(id)) {
    errors.push("manifest id는 Windows 예약 파일명을 사용할 수 없습니다.");
  }
  if (!HARNESS_ID_PATTERN.test(name)) {
    errors.push("manifest name은 소문자 영문, 숫자, 하이픈으로 된 1~64자여야 합니다.");
  }
  if (description.length < 12 || description.length > 500) {
    errors.push("manifest description은 12~500자여야 합니다.");
  }
  if (
    rawManifest.providers !== undefined &&
    (!Array.isArray(rawManifest.providers) ||
      rawManifest.providers.length === 0 ||
      rawManifest.providers.some((provider) => provider !== "codex" && provider !== "claude"))
  ) {
    errors.push("manifest providers에는 codex와 claude만 사용할 수 있습니다.");
  }
  if (!VERSION_PATTERN.test(version) || version.endsWith(".") || version.includes("..")) {
    errors.push("manifest version은 1.0.0 형식의 semver여야 합니다.");
  }
  if (version.length > 64) {
    errors.push("manifest version은 64자를 넘을 수 없습니다.");
  }
  if (rawManifest.schemaVersion !== undefined && rawManifest.schemaVersion !== HARNESS_SCHEMA_VERSION) {
    errors.push(`지원하지 않는 manifest schemaVersion입니다: ${String(rawManifest.schemaVersion)}`);
  }
  if (maxSubagents < 0 || maxSubagents > 8) {
    errors.push("maxSubagents는 0~8 사이의 정수여야 합니다.");
  }
  if (
    rawManifest.maxSubagents !== undefined &&
    (typeof rawManifest.maxSubagents !== "number" || !Number.isInteger(rawManifest.maxSubagents))
  ) {
    errors.push("maxSubagents는 정수여야 합니다.");
  }
  if (
    rawManifest.outputs !== undefined &&
    (!Array.isArray(rawManifest.outputs) ||
      rawManifest.outputs.some((output) => typeof output !== "string" || output.trim().length > 300))
  ) {
    errors.push("manifest outputs는 각각 300자 이하인 문자열 배열이어야 합니다.");
  }
  if (value.files.length === 0 || value.files.length > HARNESS_MAX_FILES) {
    errors.push(`files는 1~${HARNESS_MAX_FILES}개여야 합니다.`);
  }

  const files: HarnessCandidateFile[] = [];
  const seenPaths = new Set<string>();
  const seenPortablePaths = new Set<string>();
  let totalBytes = 0;

  for (const rawFile of value.files) {
    if (!isRecord(rawFile)) {
      errors.push("각 file은 path와 content를 가진 객체여야 합니다.");
      continue;
    }
    const filePath = normalizedString(rawFile.path).replaceAll("\\", "/");
    const content = typeof rawFile.content === "string" ? rawFile.content.replace(/\r\n/g, "\n") : "";
    if (
      !ALLOWED_FILE_PATH.test(filePath) ||
      filePath.includes("//") ||
      filePath.split("/").some(
        (segment) =>
          segment === "." ||
          segment === ".." ||
          segment.startsWith(".") ||
          segment.endsWith(".") ||
          WINDOWS_RESERVED_BASENAME.test(segment.split(".")[0] ?? ""),
      )
    ) {
      errors.push(`허용되지 않은 하네스 파일 경로입니다: ${filePath || "(empty)"}`);
      continue;
    }
    if (seenPaths.has(filePath)) {
      errors.push(`중복된 하네스 파일 경로입니다: ${filePath}`);
      continue;
    }
    const portablePath = filePath.toLowerCase();
    if (seenPortablePaths.has(portablePath)) {
      errors.push(`대소문자를 구분하지 않는 파일시스템에서 충돌하는 경로입니다: ${filePath}`);
      continue;
    }
    seenPaths.add(filePath);
    seenPortablePaths.add(portablePath);
    const bytes = Buffer.byteLength(content, "utf8");
    totalBytes += bytes;
    if (bytes === 0 || bytes > HARNESS_MAX_FILE_BYTES) {
      errors.push(`${filePath} 크기는 1~${HARNESS_MAX_FILE_BYTES} bytes여야 합니다.`);
    }
    files.push({ path: filePath, content });
  }

  if (totalBytes > HARNESS_MAX_TOTAL_BYTES) {
    errors.push(`하네스 전체 크기는 ${HARNESS_MAX_TOTAL_BYTES} bytes를 넘을 수 없습니다.`);
  }
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill) {
    errors.push("SKILL.md 파일이 반드시 필요합니다.");
  } else {
    errors.push(...validateSkill(manifest, skill.content));
  }
  for (const file of files.filter((candidate) => candidate.path.startsWith("agents/"))) {
    if (!file.path.endsWith(".md") || file.path.slice("agents/".length).includes("/")) {
      errors.push(`agents/에는 한 단계의 Markdown 파일만 둘 수 있습니다: ${file.path}`);
      continue;
    }
    errors.push(...validateAgent(file.path, file.content));
  }
  if (maxSubagents === 0 && files.some((file) => file.path.startsWith("agents/"))) {
    errors.push("agents/ 파일을 포함하려면 maxSubagents를 1 이상으로 설정해야 합니다.");
  }
  const agentFileCount = files.filter((file) => file.path.startsWith("agents/")).length;
  if (maxSubagents > 0 && agentFileCount === 0) {
    errors.push("maxSubagents가 1 이상이면 agents/ 역할 파일을 하나 이상 포함해야 합니다.");
  }
  if (agentFileCount > maxSubagents) {
    errors.push(`agents/ 역할 파일 수(${agentFileCount})가 maxSubagents(${maxSubagents})를 넘을 수 없습니다.`);
  }
  const sortedPaths = [...seenPortablePaths].sort();
  for (const [index, filePath] of sortedPaths.entries()) {
    if (sortedPaths.slice(index + 1).some((otherPath) => otherPath.startsWith(`${filePath}/`))) {
      errors.push(`파일과 디렉터리 경로가 충돌합니다: ${filePath}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    manifest,
    files,
    digest: harnessCandidateDigest({ manifest, files }),
  };
}

export function extractHarnessCandidate(text: string): HarnessCandidateExtraction {
  const pattern = new RegExp("```" + HARNESS_CANDIDATE_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "gi");
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    return { candidate: null, error: null };
  }

  const payload = matches.at(-1)?.[1]?.trim() ?? "";
  try {
    return { candidate: validateHarnessCandidate(JSON.parse(payload) as unknown), error: null };
  } catch (error) {
    return {
      candidate: null,
      error: error instanceof Error ? error.message : "하네스 후보를 읽을 수 없습니다.",
    };
  }
}

export function extractHarnessInterviewBrief(text: string): HarnessInterviewExtraction {
  const pattern = new RegExp("```" + HARNESS_INTERVIEW_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "gi");
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    return { brief: null, error: null };
  }

  const payload = matches.at(-1)?.[1]?.trim() ?? "";
  try {
    return { brief: validateHarnessInterviewBrief(JSON.parse(payload) as unknown), error: null };
  } catch (error) {
    return {
      brief: null,
      error: error instanceof Error ? error.message : "설계 브리프를 읽을 수 없습니다.",
    };
  }
}

export function stripHarnessCandidateBlock(text: string): string {
  const pattern = new RegExp("\\n?```" + HARNESS_CANDIDATE_FENCE + "\\s*\\n[\\s\\S]*?\\n```", "gi");
  return text.replace(pattern, "").trim();
}

export function stripHarnessBuilderBlocks(text: string): string {
  const withoutBrief = text.replace(
    new RegExp("\\n?```" + HARNESS_INTERVIEW_FENCE + "\\s*\\n[\\s\\S]*?\\n```", "gi"),
    "",
  );
  return stripHarnessCandidateBlock(withoutBrief);
}
