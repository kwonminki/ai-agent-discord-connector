# Discord 스타일 · 스킬

기본값은 `attention-kind` 스타일과 `karpathy-guidelines`, `verification-before-completion` 두 스킬입니다. 원문은 저장소의 `agent-assets/vendor/`에 고정해 두며, 실행 중 GitHub에서 내려받지 않습니다.

## 명령

| 명령 | 동작 |
| --- | --- |
| `/set_style` | 스타일 드롭다운을 엽니다. |
| `/set_style style:attention-kind` | 핵심부터 친절하게 전달하는 기본 스타일 |
| `/set_style style:rundown` | 요약과 진행 상태 중심 |
| `/set_style style:spartan` | 짧고 직설적인 스타일 |
| `/set_style style:tldr` | 최소한의 핵심 답변 |
| `/set_style style:off` | 스타일만 끕니다. 스킬 설정은 유지합니다. |
| `/set_style style:inherit` | 스타일만 부모 채널 또는 기본값을 상속합니다. |
| `/set_skill skill:karpathy-guidelines enabled:false` | 코딩 지침을 끕니다. `true`로 다시 켭니다. |
| `/set_skill skill:verification-before-completion enabled:false` | 완료 전 검증 지침을 끕니다. `true`로 다시 켭니다. |
| `/skills` | 현재 스타일·스킬 상태를 봅니다. |
| `/pure` | 이 채널의 커넥터 스타일과 위 스킬들을 모두 끕니다. |
| `/skills_reset` | 이 채널의 개별 설정을 지우고 부모 채널 또는 기본값으로 복원합니다. |

Slash command 목록이 갱신되기 전에는 일반 메시지로 `/set_style tldr`, `/set_skill karpathy-guidelines off`, `/pure`처럼 입력할 수도 있습니다. 기존 단발성 `/skill` 명령과는 별개입니다.

부모 채널에서 설정하면 개별 설정이 없는 하위 스레드가 그 값을 상속합니다. 스레드에서는 그 대화에만 적용됩니다. 스타일과 스킬 목록은 독립적으로 상속하며, 스킬을 하나라도 개별 변경하면 그때의 전체 스킬 목록을 해당 대화에 저장합니다. `/skills_reset`으로 목록 전체의 상속을 다시 켤 수 있습니다. 부모 채널과 연결되지 않은 기존 단독 채널은 내장 기본값을 사용합니다.

설정 변경은 **다음 요청부터** 적용됩니다. 실행 중인 작업을 중단하거나 그 작업에 설정 명령을 메시지로 전달하지 않습니다. Gateway 대기열에서 아직 제출되지 않은 작업에는 시작 시점의 설정이 들어가며, Worker에 이미 제출된 작업은 제출 시 저장한 설정을 사용합니다. `/fork`는 원본 대화의 현재 설정을 복사하고, 이후 두 대화는 독립적으로 변경할 수 있습니다.

설정은 Gateway 작업 디렉터리의 `.connect/agent-guidance-settings.json`에 저장됩니다. 서비스 재시작 후에도 같은 작업 디렉터리를 사용하면 유지됩니다. 설정 파일이 손상되면 오류로 처리하며, `/pure`가 조용히 기본값으로 바뀌지 않습니다. Slash command와 드롭다운 모두 기존 Operator 역할 검사를 거칩니다.

## 두 agent에 적용하는 방법

### Codex

Worker는 선택된 원문을 복사한 불변 디렉터리와 그 파일들을 링크하는 `AGENTS.md`를 생성합니다. 각 요청에 해당 `AGENTS.md`의 절대 경로를 넣어 먼저 읽도록 지시합니다. 따라서 프로젝트 위치와 무관하게 같은 스타일을 선택하고, 기존 세션에서도 다음 요청의 설정을 명시할 수 있습니다.

이는 Codex가 프로젝트 상위 경로를 탐색해 자동 발견하는 방식과 별개인 **명시적 파일 링크**입니다. 사용자 프로젝트의 `AGENTS.md`를 생성하거나 덮어쓰지 않습니다. Codex CLI exec와 app-server 경로에 모두 적용됩니다.

### Claude Code

선택한 스타일은 격리된 로컬 plugin의 `output-styles/<style>.md`로 변환합니다. `--plugin-dir`로 로드하고 CLI settings의 `outputStyle`을 `cdc-guidance:<style>`로 설정합니다. `keep-coding-instructions: true`를 사용해 Claude의 기본 코딩 지침을 유지합니다. 이 형식은 [Claude Code output styles](https://code.claude.com/docs/en/output-styles)와 [plugin reference](https://code.claude.com/docs/en/plugins-reference)에 기반합니다.

사용자의 기존 CLI settings는 보존하면서 선택된 스타일만 병합합니다. 기존 settings가 JSON이거나 작업 폴더 기준의 파일 경로인 경우를 모두 지원합니다. 코딩·검증 스킬은 Codex와 같은 `AGENTS.md` 링크로 읽도록 지시합니다.

설정이 달라지면 다음 요청 때 해당 대화의 Claude 프로세스를 다시 시작하고 같은 session ID로 재개합니다. 다른 대화의 프로세스는 건드리지 않습니다. **프로세스 안에만 있던 예약·백그라운드 작업은 이 재시작의 영향을 받을 수 있습니다.** 프로젝트나 사용자 전역의 `.claude/settings.json`, `CLAUDE.md`는 변경하지 않습니다. 네이티브 `/compact` 명령 앞에는 링크를 붙이지 않습니다.

### 기본 스킬의 사용 시점

- `karpathy-guidelines`: 코드를 작성·리뷰·디버깅·리팩터링하기 전에 원문을 읽도록 지시합니다. 일반 대화에서는 불필요한 코딩 절차를 요구하지 않습니다.
- `verification-before-completion`: 완료·성공을 주장하기 전에 원문을 읽고 작업에 맞는 검증을 수행하도록 지시합니다. 실행하지 않은 검사나 남은 한계를 분명히 알리게 합니다.

이 기능은 agent에게 전달하는 지침입니다. 실제로 모든 답변에서 파일 읽기와 검증을 수행했는지 강제하는 실행 차단기는 아닙니다.

### `/pure`의 범위

이 기능으로 추가한 스타일과 스킬을 해제합니다. 사용자가 직접 둔 프로젝트 지침, 개인 설정, 별도로 선택한 Harness는 유지합니다. Claude의 커넥터 output-style plugin은 다음 요청에서 제거하고 원래 CLI settings를 사용합니다.

같은 세션의 과거 대화 내용을 삭제하지는 않습니다. 대신 이전 커넥터 지침을 더 이상 적용하지 말라는 짧은 `AGENTS.md`를 전달합니다. 대화 기록까지 비운 상태가 필요하면 새 대화를 만들고 `/pure`를 설정하세요. 부모 채널에 `/pure`를 설정하면 새 스레드도 상속합니다.

## 확장 구조

- `packages/core/src/agentGuidance.ts`: 스타일·스킬 카탈로그, 기본값, 허용 ID 검증
- `apps/discord-bot/src/agentGuidanceStore.ts`: 채널별 설정, 상속, 저장, fork 복사
- `apps/discord-bot/src/agentGuidanceCommands.ts`: 명령 해석과 드롭다운
- `apps/local-agent/src/agentGuidanceRuntime.ts`: 원문 스냅샷, AGENTS 링크, Claude native output style
- `agent-assets/sources.json`: 출처 URL, 고정 commit, 원문 파일별 SHA-256

새 스킬을 추가할 때:

1. 검토한 원문과 필요한 참조 파일·라이선스를 `agent-assets/vendor/<source>/`에 저장합니다.
2. `sources.json`에 commit과 각 파일의 SHA-256을 기록합니다. 기존 원문을 포맷터로 변경하지 않습니다.
3. `AGENT_SKILLS`에 `id`, `label`, `file`, `when`, `defaultEnabled`를 추가합니다. 원문이 다른 파일에 의존하면 runtime 스냅샷에 그 참조 파일도 포함되도록 확장합니다.
4. 새 스타일은 `AGENT_STYLES`에 추가합니다. ID는 소문자 영문·숫자·하이픈으로 구성한 파일명 가능한 고유값을 사용합니다. 메뉴 선택지와 검증 스키마가 카탈로그를 함께 사용합니다.
5. 기본값 변경, 꺼진 상태, 세션 재개, 원문 해시 검사를 실행합니다. 기본 활성 여부는 새 항목의 `defaultEnabled`로 명시합니다.

사용자가 임의 URL이나 파일 경로를 명령에 넣어 실행하는 기능은 없습니다. `/pure`는 빈 스킬 목록을 명시적으로 저장하므로 향후 기본 스킬을 추가해도 계속 꺼진 상태를 유지합니다. 지침 생성 형식 자체가 바뀌면 runtime의 digest version도 올려 이전 스냅샷을 재사용하지 않도록 합니다.

## 배포와 확인

Gateway와 Worker를 같은 기능 버전으로 업데이트해야 합니다. 기존 `.connect/` 설정·작업 상태는 보존하고, 작업을 마친 뒤 서비스를 재시작하세요. Gateway가 slash commands를 다시 등록한 뒤 `/skills`와 `/set_style` 메뉴를 확인합니다.

테스트:

```sh
pnpm test
pnpm typecheck
npm pack --dry-run
```

검증 범위에는 권한, 상속·재시작·fork, raw 파일 해시, 동시에 만드는 스냅샷, Codex app-server 세션 재개, Claude native outputStyle 변경과 `/pure` 시 해제, 기존 settings 보존이 포함됩니다. 라이브 모델의 답변 스타일 품질은 별도 대화로 확인해야 합니다.

원문 출처와 라이선스는 [agent-assets/README.md](../agent-assets/README.md), 적용하지 않은 Python 제안은 [python-anti-slop-proposal.ko.md](python-anti-slop-proposal.ko.md)를 참고하세요.
