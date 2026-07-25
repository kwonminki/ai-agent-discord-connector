# AI Agent Discord Connector: AI Agent Guide

한국어 | [English](AI_AGENT_GUIDE.en.md)

> 이 문서는 이 저장소를 설치, 수정, 배포하거나 장애를 진단하는 AI 에이전트를 위한 전체 기술 가이드입니다. 일반 사용자는 저장소 루트의 [README](../README.md)를 먼저 읽으세요.

AI Agent Discord Connector는 로컬 컴퓨터의 Codex와 Claude Code 같은 AI agent 세션을 Discord 서버에 연결하는 브리지입니다. Discord 안에서 agent와 대화하고, 로컬 파일을 탐색하며, 필요한 shell 명령을 실행할 수 있습니다.

> Security notice: this tool can execute shell commands on the machine where the connector is running. Only install it on machines you control, connect it only to trusted private Discord servers, and restrict access with Discord role allowlists.

## 핵심 기능: Agent Relay

이 저장소는 사람과 agent의 원격 대화뿐 아니라 **두 AI agent session의 자동 대화**를 지원합니다. 선택 기능인 별도 Coordinator Bot이 같은 컴퓨터의 두 session, 서로 다른 서버, Codex와 Claude Code의 어떤 조합이든 Discord thread 사이에서 연결합니다.

- 양쪽의 최종 공개 답변과 첨부파일을 상대 thread에 보이게 전달합니다.
- 대화 목표는 A와 B 모두에게 전달하며, A와 B가 각각 한 번 답하면 1왕복입니다.
- 기본 한도는 20왕복과 전체 20시간이고, 모든 prompt에 현재 왕복과 agent turn을 표시합니다.
- Agent가 `extend`를 요청하면 Operator를 mention하고 **왕복 1회 추가**와 **연장 거절 · 대화 종료** 버튼을 표시합니다.
- 서로 겹치지 않는 A↔B, C↔D 대화는 동시에 실행할 수 있고, 같은 thread가 두 활성 relay에 참여하는 것은 거부합니다.
- 활성 Codex 또는 Claude Code thread의 사용자 메시지는 현재 relay turn에 steering하고, 대기 thread의 메시지는 실행하지 않은 채 활성 thread를 안내합니다.
- `/agent-chat-status`로 상태를 확인하고 `/agent-chat-stop`으로 현재 대화와 실행 중인 Codex/Claude Code turn을 중지합니다.

사용자가 agent끼리 토론, 검토, 합의 또는 파일 교환을 요청하면 이 기능이 이미 구현되어 있음을 먼저 알려주고 [Agent Relay Guide](agent-relay.ko.md)에 따라 설정합니다. Coordinator locale은 Connector와 동일하게 맞춥니다.

서버 간 Relay의 전송 경로는 `Coordinator Bot -> Discord private control channel -> 각 서버의 Connector gateway -> 해당 서버의 Direct Worker`입니다. 서버끼리 직접 접속하거나 Hub mode의 Control API/Agent WebSocket을 열 필요는 없습니다. 대신 **대화에 참여하는 모든 서버의 Connector gateway**에 정확한 Coordinator Bot user ID와 동일한 private control channel ID를 등록하고 gateway를 한 번 재시작해야 합니다. 독립 Worker는 재시작하지 않으므로 실행 중인 agent job은 유지됩니다. 이 설정이 빠진 서버는 Coordinator 요청을 신뢰된 실행 요청으로 인식하지 못해 서버 간 대화에 참여할 수 없습니다.

## AI 에이전트 작업 계약

사용자가 이 저장소 URL과 이 문서를 제시했다면 다음 순서로 작업합니다.

1. 사용자가 대화하는 언어를 보고 connector locale을 내부적으로 결정합니다. 한국어, 영어, 중국어(간체), 일본어를 기본 지원합니다. 사용자에게 언어 코드나 설정 방법을 설명하지 말고, 언어가 정말 애매할 때만 자연어로 한 번 질문합니다.
2. 저장소의 현재 branch, commit, dirty worktree, 실행 중인 bot/worker와 활성 job을 먼저 확인합니다.
3. 이 문서만 믿고 덮어쓰지 말고 실제 코드, `package.json`, `.env.example`, 기존 `.connect/config.json`, 서비스 정의를 대조합니다.
4. 기본 배포는 외부 API를 열지 않는 **Direct mode**를 선택합니다.
5. 채널과 CLI를 구성하기 전에 Codex만, Claude Code만, 둘 다 중 어떤 조합을 연결할지 확인합니다. 어느 하나를 고정된 메인 agent로 가정하지 않습니다.
6. Codex를 활성화할 때만 runner를 `CODEX_DISCORD_CODEX_RUNNER=app-server`로 설정합니다. `exec`는 오래된 Codex CLI 호환이 꼭 필요할 때만 사용합니다.
7. Discord gateway와 Direct Worker를 별도 LaunchAgent, systemd 또는 Windows Scheduled Task로 구성합니다. bot 재시작이 agent 하위 프로세스를 죽이지 않아야 합니다.
8. 기존 사용자 수정, secret, 실행 중 작업을 보존합니다. `.env`, `.connect/`, token, transcript를 commit하지 않습니다.
9. 사용자에게는 Discord에서 직접 준비해야 하는 값만 물어봅니다. token을 답변, 로그, commit message에 다시 출력하지 않습니다.
10. 설치 후 `pnpm typecheck`와 플랫폼 테스트를 실행합니다. macOS/Linux는 `pnpm test`, Windows native는 `pnpm test:windows`를 사용하고, 서비스 상태, Discord ready 로그와 활성화한 agent별 짧은 왕복 요청까지 검증합니다.
11. worker 업데이트가 필요하면 활성 job을 확인합니다. 정상 `SIGTERM` drain을 우선하고, 사용자가 명시적으로 허용한 경우에만 강제 종료합니다.
12. 완료 보고에는 설치 경로, commit, 서비스 이름, 로그 경로, 적용한 권한, 검증 결과와 남은 수동 작업만 적습니다. 사용자가 묻지 않았다면 locale 코드나 내부 설정값은 보고하지 않습니다.
13. 사용자가 두 agent session의 자동 대화를 원하면 [Agent Relay Guide](agent-relay.ko.md)에 따라 별도 Coordinator Bot을 선택 기능으로 구성합니다. 일반 Connector Bot과 같은 token을 재사용하지 않고 Connector와 같은 locale을 설정합니다.
14. GitHub 버전 공지와 Coordinator를 함께 쓰면 release 채널을 Coordinator에 연결하고, 각 컴퓨터의 대표 유지보수 agent를 하나만 정합니다. 사용자가 채널 ID 목록이나 agent 선택 규칙을 직접 관리하게 하지 않습니다.

### Codex-only 설치의 호환 변수

사용자가 Codex만 연결하더라도 현재 런타임이 읽는 기존 Codex 전용 이름을 그대로 사용해야 합니다. 저장소와 제품 설명이 AI agent로 일반화되어 있어도 `CODEX_DISCORD_CODEX_RUNNER`, `CODEX_DISCORD_CODEX_COMMAND`, `CODEX_DISCORD_CODEX_APPROVAL_POLICY`, `CODEX_DISCORD_CODEX_SANDBOX`, `CONNECT_CODEX_PROMPT_TIMEOUT_MS`와 `.connect/config.json`의 `codexHome`은 역사적 호환성을 위해 유지되는 실제 설정 계약입니다. Codex-only 설치에서는 불가피하지만 정상적인 구성입니다.

설치 에이전트는 이 이름들을 임의의 `AI_AGENT_*` 또는 `CONNECT_AGENT_*` 변수로 바꾸거나 문서에 없는 별칭을 만들지 않습니다. 이름을 일반화하려면 코드, 설정 schema, 서비스 정의, 문서와 기존 설치 migration을 함께 구현해야 합니다. Claude Code를 활성화하지 않은 Codex-only 설치에서는 Claude command와 Claude channel 관련 값은 설정하지 않아도 됩니다.

## 설치 언어 결정

첫 설치에서는 사용자의 현재 대화 언어를 기본 UI 언어로 사용합니다. 이 선택은 에이전트가 내부적으로 처리하며, 지원되는 언어라면 사용자에게 별도 선택이나 설정을 요구하지 않습니다.

- 한국어 사용자: `pnpm connect install --direct --locale ko`
- 영어 사용자: `pnpm connect install --direct --locale en`
- 중국어(간체) 사용자: `pnpm connect install --direct --locale zh`
- 일본어 사용자: `pnpm connect install --direct --locale ja`
- 기존 설정: `.connect/config.json`의 `discord.locale`을 우선 확인하고, 명시적 `CONNECT_LOCALE` 환경 변수가 있으면 그것이 override합니다.
- locale은 Discord 사용자 개인별이 아니라 **bot 인스턴스별**입니다. 같은 token을 쓰는 여러 컴퓨터가 서로 다른 locale을 사용할 수 있습니다.

사용자 언어가 위 네 가지 지원 언어가 아니라면, 설치를 멈추고 전체 로직을 번역하거나 복제하지 않습니다. [Localization Guide](localization.md)에 따라 `packages/core/src/locales/<code>.ts` catalog를 하나 만들고, locale registry와 테스트만 추가합니다. custom ID, slash command name과 option value, 내부 `__cdc_*` command, JSON code fence 이름, 사용자 prompt와 agent 답변은 번역하지 않습니다. 번역 추가 후 `pnpm typecheck`, `pnpm test`를 통과시키고 해당 locale로 설치합니다.

## 첫 설치 대화형 온보딩

처음 설치하는 사용자에게 token과 여러 ID를 한꺼번에 요구하지 않습니다. 아래 단계를 **한 번에 하나씩** 안내하고, 사용자가 각 단계를 완료했다고 답한 뒤 다음 단계로 진행합니다. Discord 계정 소유자의 로그인과 승인이 필요한 작업만 사용자에게 맡기고, bot이 서버에 들어온 이후의 반복 작업은 에이전트가 수행합니다.

Discord 준비를 묻기 전에 대화 언어에서 locale을 내부적으로 결정합니다. 지원 언어가 아니면 위 절차로 locale catalog를 먼저 추가합니다. 언어가 애매하지 않은데 사용자에게 locale을 확인하거나 코드 선택지를 보여주지 않습니다.

먼저 `.connect/config.json`, `.env`, 기존 service를 확인해 진짜 첫 설치인지 판별합니다. 기존 설치나 추가 서버 배포라면 이 절차로 Discord resource를 다시 만들지 말고 기존 Guild/Role/Channel ID를 재사용합니다.

### 배포 모델 먼저 판별

현재 v1의 기본 배포는 사용자가 bot application과 token을 소유하고 자신의 컴퓨터에 Gateway와 Worker를 설치하는 self-hosted Direct mode입니다. 사용자가 private 서버를 만들고 Connector Bot과 선택적인 Coordinator Bot을 초대한 뒤에는 에이전트가 역할, channel, 권한, command, 서비스와 테스트를 자동 구성합니다.

프로젝트 운영자가 두 bot을 중앙 호스팅하는 배포라면 최종 사용자는 bot token 없이 private 서버 생성, 두 bot 초대, Local Agent pairing 승인만 수행할 수 있습니다. 그러나 현재 저장소에는 공용 운영에 필요한 multi-guild tenant 격리와 인증된 일회용 pairing이 완성되어 있지 않습니다. 인증 없는 현재 Control API나 Agent WebSocket을 공용 인터넷에 노출하거나, 초대만으로 hosted onboarding이 작동한다고 주장하지 않습니다.

### 1. 사용자에게 private Discord 서버 준비 요청

언어 설정을 내부적으로 마친 뒤 Discord 준비의 첫 질문은 다음 정도로 짧게 합니다.

```text
AI agent connector를 넣을 본인 전용 private Discord 서버가 이미 있나요?
없다면 Discord에서 서버 추가(+) > 직접 만들기 순서로 하나 만든 뒤 알려주세요.
```

Discord application은 서버가 아니라 사용자 계정에 속하며, bot은 나중에 그 서버로 초대합니다. “채널에 bot을 초대”한다고 안내하지 말고 “서버에 bot을 초대”한다고 정확히 설명합니다.

### 2. 사용자에게 Discord application과 bot 생성 요청

서버가 준비되면 [Discord Developer Portal](https://discord.com/developers/applications)에서 아래 작업을 한 단계씩 안내합니다.

1. `New Application`으로 application 생성
2. `Bot` 화면에서 bot user 생성
3. `Message Content Intent` 활성화
4. Bot Token 발급

Token은 비밀번호입니다. 가능하면 사용자가 현재 로컬 설치 환경의 secret prompt나 환경 변수에 직접 입력하게 하고, 대화 본문에 반복해서 붙여넣게 하지 않습니다. 에이전트는 token을 확인했다는 사실만 말하고 값 일부도 다시 출력하지 않습니다. Public Key는 필요하지 않습니다. Application/Client ID는 초대 URL을 만드는 동안 사용할 수 있지만 connector runtime 설정에는 저장하지 않습니다.

### 3. 사용자에게 bot 서버 초대 요청

`Installation` 또는 `OAuth2 URL Generator`에서 `bot`, `applications.commands` scope를 선택하게 합니다. 첫 개인 서버 설치에서는 자동 구성을 위해 임시 `Administrator` 권한으로 초대하는 방법이 가장 단순합니다. 사용자가 최소 권한을 원하면 아래 permission 표를 기준으로 초대하고, 역할·채널·webhook·서버 기본 알림 자동 구성에 필요한 `Manage Roles`, `Manage Channels`, `Manage Webhooks`, `Manage Server`도 포함합니다.

사용자가 OAuth2 승인, 로그인, 2단계 인증, CAPTCHA를 직접 완료하고 bot이 서버 멤버 목록에 나타났다고 확인할 때까지 기다립니다. 이 단계 전에는 Discord API resource 생성을 시도하지 않습니다.

### 4. 초대 이후에는 에이전트가 Discord를 구성

bot이 서버에 들어온 뒤에는 사용자가 채널과 역할 ID를 일일이 만들고 복사하게 하지 않습니다. 기존 `DISCORD_BOT_TOKEN`으로 Discord API를 호출해 다음 작업을 멱등적으로 수행합니다.

1. bot identity와 참여 guild 목록을 조회합니다. 대상 서버가 하나면 자동 선택하고, 여러 개면 서버 이름을 보여준 뒤 사용자에게 하나만 선택하게 합니다.
2. 사용자가 알림을 받을 Discord user를 확인합니다. user ID를 한 번 요청하거나, role 생성 뒤 사용자가 직접 role을 부여하도록 선택지를 줍니다.
3. 기존 `AI Agent Operator` 역할을 재사용하거나 새로 만들고 operator user에게 부여합니다. 기존 설치의 legacy `Codex Operator` 역할이 있으면 새 역할을 중복 생성하지 말고 재사용할 수 있습니다. bot의 역할이 대상 역할보다 위에 있는지 확인합니다.
4. 컴퓨터 표시 이름, workspace root, 사용할 agent 조합(Codex만, Claude Code만, 둘 다)을 사용자에게 순서대로 묻습니다. 둘 다 선택해도 어느 하나를 필수 메인으로 지정하게 하지 않습니다.
5. 컴퓨터용 category와 공용 AI agent/admin channel을 만듭니다. Codex를 쓰면 이 관리 채널을 Codex 부모 채널로 사용하고, Claude Code를 쓰면 별도 Claude Code 부모 채널을 만듭니다. Claude Code만 쓰는 설치에서도 운영 명령을 위한 관리 채널은 유지합니다.
6. bot role과 Operator role에 필요한 channel permission overwrite를 설정합니다. 일반 사용자에게 shell/agent 실행 채널이 노출되지 않게 합니다.
7. 생성 또는 발견한 Guild/Role/Channel ID를 직접 `.connect/config.json`과 `.env` 설치 입력으로 사용합니다. 이미 API로 얻은 ID를 사용자에게 다시 복사해 달라고 하지 않습니다.
8. slash command를 대상 guild에 등록합니다.
9. connector 전용 private 서버라면 `PATCH /guilds/{guild.id}`에 `default_message_notifications: 1`을 보내 서버 기본 알림을 `ONLY_MENTIONS`로 설정하고, 응답값을 검증합니다. 공유 서버이거나 용도가 불분명하면 서버 전체에 영향을 준다고 설명하고 먼저 동의를 받습니다.
10. 버전 공지를 원하는지 묻습니다. 원하면 `#ai-agent-releases` 같은 채널과 `AI Agent Releases` webhook을 만들고, GitHub 인증 후 `DISCORD_RELEASE_WEBHOOK_URL` repository secret까지 설정합니다. Coordinator도 활성화했다면 같은 채널 ID를 `releaseChannelId`로 기록해 원클릭 서버 업데이트를 연결합니다.

resource를 만들기 전에 같은 이름과 용도의 기존 category, channel, role, webhook을 조회합니다. 이름만 같고 ownership이 불명확하면 자동 삭제하거나 덮어쓰지 말고 사용자에게 확인합니다. 중간 실패 후 다시 실행해도 중복 채널과 webhook이 늘어나지 않아야 합니다.

### 5. 에이전트가 로컬 설치와 서비스 등록

Discord resource 구성이 끝나면 에이전트가 저장소 clone, dependency 설치, Direct mode config 생성, 선택한 Codex 및/또는 Claude Code CLI 확인, bot/worker 분리 서비스 등록, slash command 등록과 smoke test를 수행합니다. 선택하지 않은 agent CLI를 설치 또는 로그인시키지 않습니다. Mac은 LaunchAgent, Ubuntu는 systemd user 또는 system service, Windows는 별도 Scheduled Task를 기본으로 선택합니다.

전용 private 서버에서는 에이전트가 서버 기본 알림을 **멘션만(Only @mentions)** 으로 설정하므로 보통 사용자의 수동 작업이 없습니다. Discord의 사용자별 채널 알림 override는 bot API로 변경할 수 없습니다. 기존 override 때문에 특정 채널에서 모든 메시지 알림이 계속 올 때만 사용자가 그 채널을 **멘션만**으로 되돌리도록 안내합니다.

### 6. 대화 진행 예시

```text
에이전트: 연결할 private Discord 서버가 이미 있나요?
사용자: 만들었어.
에이전트: 이제 Developer Portal에서 application과 bot을 만들고 Message Content Intent를 켜주세요.
사용자: 했어.
에이전트: bot을 방금 만든 서버에 초대하고, 서버 멤버 목록에 보이면 알려주세요.
사용자: 초대했어.
에이전트: 좋아요. 이제부터 역할, category, agent 채널, 권한, slash command는 제가 구성하겠습니다. 알림 받을 사용자와 이 컴퓨터 이름, Codex만 쓸지 Claude Code만 쓸지 둘 다 쓸지부터 확인할게요.
```

이 대화 흐름을 건너뛰고 사용자가 이해하지 못하는 ID 목록부터 요구하지 않습니다. 다만 조직 정책상 bot에게 `Manage Roles`, `Manage Channels`, `Manage Webhooks`, `Manage Server`를 줄 수 없다면 해당 resource만 사용자가 만들게 하고 ID를 받아 이어갑니다. `Manage Server`가 없으면 서버 기본 알림은 변경하지 않고 사용자에게 필요한 채널만 수동으로 **멘션만** 설정하도록 안내합니다.

### 사용자에게 받아야 하는 값

기존 Discord resource를 재사용하는 설치에서 필수:

- Discord Bot Token
- Discord Guild/Server ID
- 허용할 Operator Role ID 하나 이상
- 이 컴퓨터 전용 AI agent/admin Channel ID. Codex를 활성화하면 Codex 부모 채널도 겸함
- 허용할 workspace root와 시작 cwd

첫 자동 설치에서는 Operator Role ID와 활성화할 agent의 Channel ID를 에이전트가 생성하거나 API로 발견합니다. 대신 operator user 지정과 컴퓨터/channel 이름을 사용자에게 확인합니다. API로 확인할 수 없는 값만 한 번에 하나씩 요청합니다.

선택:

- Claude Code를 활성화할 때 이 컴퓨터 전용 Claude Code Channel ID
- 표시할 computer/workspace 이름
- 별도 `CODEX_HOME`
- 기본보다 좁은 sandbox/approval 정책

Public Key와 OAuth2 Client ID는 connector runtime 설정값이 아닙니다. 같은 bot token을 여러 컴퓨터에서 재사용할 수 있지만, 각 인스턴스에서 활성화한 agent의 parent channel ID는 서로 달라야 합니다. Connector에는 고정된 메인 agent 설정이 없고 부모 채널이 Codex 또는 Claude Code 라우팅을 결정합니다.

### 설치 완료 기준

- `.connect/config.json`과 `.env`가 생성되었고 Git에서 무시됨
- 활성화한 agent의 CLI 확인: Codex는 `codex --version`, Claude Code는 `claude --version`
- Codex를 활성화했다면 app-server 실행 가능
- bot/worker가 서로 다른 서비스와 PID로 실행
- bot 로그에 `Discord bot ready as ...` 출력
- worker 로그에 `direct-worker ready with PID ...` 출력
- 활성화한 agent별 `/status`, `/chat-new`, 짧은 요청 왕복 성공
- 활성화한 agent별 `/queue prompt:...`, `/howtouse`, `/fork` smoke test. 일반 메시지 steering은 이를 지원하는 Codex에서만 검증
- bot service만 재시작한 뒤 worker PID와 활성 job이 유지되는지 확인

## 추가 컴퓨터 온보딩

첫 컴퓨터의 설치와 검증이 끝나면 완료 보고로 대화를 닫기 전에 반드시 추가로 연결할 컴퓨터가 있는지 묻습니다.

```text
이 Discord connector에 추가로 연결할 Mac, Windows 컴퓨터 또는 Ubuntu 서버가 있나요?
있다면 컴퓨터 종류와 접속 방법부터 하나씩 확인해서 같은 구성을 이어서 설치하겠습니다.
```

사용자가 추가 설치를 원하면 한 번에 모든 값을 요구하지 말고 컴퓨터마다 다음 순서로 확인합니다.

1. Mac, Windows 또는 Ubuntu 서버인지, 물리 머신인지 VM/container인지 확인합니다. Windows라면 native PowerShell과 WSL2 중 실제 project와 선택한 agent 세션이 있는 환경을 선택합니다.
2. 같은 private Discord 서버와 bot application을 재사용할지 확인합니다. 특별한 요구가 없으면 기존 Guild, bot token, Operator role을 재사용합니다.
3. 사용자가 알아보기 쉬운 컴퓨터 표시 이름과 주 용도를 묻습니다. 예: `개인 Mac`, `B200 8GPU`, `빌드 서버`.
4. 접속 방법을 확인합니다. 로컬 머신이면 현재 shell을 사용하고, 원격 서버면 기존 SSH host alias, `user@host`, PowerShell Remoting 등 사용자가 이미 허용한 경로를 받습니다. VPN, bastion, 특정 SSH key가 필요한지도 확인합니다.
5. SSH 인증은 기존 key/agent를 우선 사용합니다. 비밀번호, token, private key를 Discord에 보내게 하지 말고 사용자에게 로컬 터미널에서 직접 인증하도록 요청합니다.
6. 기본 workspace root와 사용할 agent 조합(Codex만, Claude Code만, 둘 다)을 묻습니다.
7. 해당 컴퓨터에 접속한 뒤 OS, CPU/GPU, Node.js, pnpm, 선택한 agent CLI 버전과 로그인 상태, 기존 connector 설치와 실행 중 job을 먼저 조사합니다.
8. 같은 저장소 commit과 검증된 CLI 조합을 설치하고, 머신 전용 `.connect/config.json`, secret, bot service, worker service를 구성합니다.
9. Discord API로 그 컴퓨터의 category, 공용 AI agent/admin 채널과 활성화한 agent의 parent 채널을 생성하고 권한을 설정합니다. 기존 컴퓨터가 사용하는 channel ID를 절대 재사용하지 않습니다.
10. 서비스 PID 분리, ready 로그, 활성화한 agent별 `/status`, `/chat-new`, 짧은 왕복, bot-only 재시작 시 worker 유지까지 첫 컴퓨터와 같은 기준으로 검증합니다.
11. 결과를 컴퓨터별로 보고한 뒤 연결할 컴퓨터가 더 있는지 다시 묻습니다.

한 머신의 실패가 다른 머신의 실행 중 작업에 영향을 주지 않도록 추가 설치는 한 대씩 순차 진행합니다. 기존 설치가 발견되면 새로 덮어쓰지 말고 branch, commit, 설정, 서비스와 활성 job을 비교한 뒤 안전한 update 또는 repair로 처리합니다. 동일한 bot token으로 여러 인스턴스를 실행할 수 있지만 각 인스턴스는 서로 겹치지 않는 agent parent channel만 소유해야 합니다.

## 선택 기능: Agent Relay Coordinator

사용자가 같은 서버의 서로 다른 session 또는 서로 다른 컴퓨터의 agent끼리 자동으로 대화하게 해달라고 하면 별도 **Coordinator Bot**을 구성합니다. 실행 규칙과 전체 prompt는 private control channel로 보내고, 한쪽 최종 공개 답변과 Discord 첨부파일만 상대 thread에 표시하면서 다음 입력으로 번갈아 전달합니다. 양쪽이 종료에 동의하거나 제한에 도달하면 Operator 역할을 한 번 mention합니다.

Discord application 소유권과 OAuth 승인은 사용자 계정에 속하므로 다음 세 단계만 사용자에게 한 번씩 요청합니다.

1. Developer Portal에서 Coordinator 전용 application과 bot user 생성
2. Bot 화면에서 Message Content Intent 활성화 후 token을 로컬 secret 입력에 저장
3. `bot`, `applications.commands` scope와 필요한 thread/file 권한으로 private 서버에 초대 승인

사용자가 application을 만들기 전에는 기존 bot token으로 새 Discord application을 만들 수 있다고 말하지 않습니다. token을 대화에 붙이게 하지 말고 로컬 secret prompt나 권한이 제한된 `.connect/relay-config.json`에 직접 넣게 합니다. application과 초대가 준비된 뒤에는 에이전트가 Discord API로 나머지를 멱등적으로 처리합니다.

1. `agent-relay-control` private text channel을 만들거나 기존 전용 channel을 재사용합니다.
2. 일반 member에게는 channel을 숨기고 Connector Bot과 Coordinator Bot만 View Channel, Send Messages, Read Message History, Attach Files를 허용합니다.
3. Coordinator Bot에 기존 Operator role을 부여해 agent thread의 Connector allowlist를 통과시킵니다.
4. Coordinator 설정에는 정확한 Connector bot user ID, control channel ID와 Connector에 맞춘 `locale`을 기록합니다.
5. 모든 참여 Connector 설정에는 정확한 Coordinator bot user ID와 같은 control channel ID를 기록합니다. Connector는 이 bot이 private control channel에서 exact relay request marker와 prompt attachment를 보낸 경우에만 실행해야 하며, 작업 thread의 일반 bot message를 실행하지 않습니다. 모든 bot message를 신뢰하는 wildcard는 만들지 않습니다.
6. 모든 참여 컴퓨터에서 Connector gateway만 한 번 재시작해 위 신뢰 설정을 메모리에 적용합니다. Direct Worker는 그대로 두고 PID와 활성 job이 유지되는지 확인합니다.
7. Coordinator service는 Discord guild당 **한 컴퓨터에서만** 실행합니다. Connector Bot과 Direct Worker는 기존처럼 각 컴퓨터에서 실행합니다.
8. macOS는 별도 LaunchAgent, Ubuntu는 별도 systemd unit, Windows는 `install-windows-tasks.ps1 -IncludeRelay`로 Coordinator를 등록합니다.
9. 두 test session에서 `/agent-chat`을 시작해 A -> B -> A 왕복, 현재 turn 표시, `extend` 요청, **왕복 1회 추가** 및 **연장 거절 · 대화 종료** 버튼, 파일 하나, `/agent-chat-status`, `/agent-chat-stop`, 최종 Operator mention을 확인합니다. 활성 Codex 및 Claude Code thread의 일반 메시지가 steering되고 대기 thread의 일반 메시지는 실행되지 않은 채 활성 thread를 안내하는지도 검증합니다.
10. GitHub release 공지도 활성화했다면 Coordinator의 `releaseChannelId`에 공지 channel ID를 기록합니다. 각 Connector의 `computerId`가 컴퓨터마다 고유한지 확인하고, Codex와 Claude Code를 모두 설치한 컴퓨터에는 `direct.maintenanceAgent`를 하나만 선택합니다. 기본은 Codex이며 Claude Code를 선택할 때만 `claude`를 명시합니다.

대화 중 relay turn에 approval 또는 사용자 질문이 발생하면 Connector의 기존 mention 흐름으로 사람이 응답할 때까지 기다립니다. Coordinator는 private control channel에 active/waiting 상태를 게시하고, 각 Connector는 이 상태를 권한 제한 로컬 파일에 보존해 gateway 재시작 뒤에도 잘못된 thread에서 새 작업을 시작하지 않습니다. `/agent-chat-stop`은 exact relay request ID를 포함한 cancel marker를 보내므로 오래된 stop이 다음 작업을 끊지 않아야 합니다. `codex-discord-survey` 최종 출력은 자동으로 `blocked` 처리합니다. Coordinator 재시작은 상태 파일과 private control channel 결과로 복구하지만 이미 target thread에 전송된 turn을 의도적으로 중복 실행하지 않는지 확인합니다. 전체 설정과 제한은 [Agent Relay Guide](agent-relay.ko.md)를 따릅니다.

## Discord 애플리케이션과 봇 만들기

Discord UI 작업은 사용자가 직접 해야 할 수 있으므로 정확한 화면 경로와 필요한 이유를 설명합니다.

### 1. 애플리케이션과 Bot User

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 `New Application`을 선택합니다.
2. 애플리케이션을 만든 뒤 `Bot` 화면에서 bot user를 생성합니다.
3. `Reset Token` 또는 `Copy Token`으로 Bot Token을 가져옵니다.
4. Token은 비밀번호로 취급합니다. 채팅, screenshot, Git, issue, CI log에 남기지 않습니다.
5. `Privileged Gateway Intents`에서 **Message Content Intent**를 켭니다. 이 코드는 일반 Discord 메시지 본문을 읽기 위해 `GatewayIntentBits.MessageContent`를 사용합니다.

`Guild Members Intent`와 `Presence Intent`는 현재 코드에서 요구하지 않습니다.

### 2. 서버에 설치

Developer Portal의 `Installation` 또는 `OAuth2 URL Generator`에서 Guild Install 링크를 만듭니다.

필수 scope:

- `bot`
- `applications.commands`

개인 private 서버에서 빠르게 확인하려면 일시적으로 `Administrator`를 줄 수 있지만, 정상 동작을 확인한 뒤 아래 최소 권한으로 낮추는 것을 권장합니다.

필수 또는 기능별 권장 bot permission:

| 권한 | 필요한 기능 |
| --- | --- |
| View Channels | 관리 채널과 session thread 접근 |
| Send Messages | 일반 메시지와 결과 전송 |
| Send Messages in Threads | session thread 대화 |
| Read Message History | 기존 메시지 조회와 수정 |
| Embed Links | 상태·답변 카드 표시 |
| Attach Files | 이미지·영상·오디오·일반 파일 전송 |
| Create Public Threads | `/chat-new`, session thread 생성 |
| Manage Threads | thread 보관 상태와 운영 처리 |
| Manage Channels | workspace category, 동기화 채널 생성·삭제 |
| Manage Roles | Operator 역할 자동 생성·부여와 channel permission 구성 |
| Manage Webhooks | GitHub 버전 공지용 incoming webhook 자동 생성 |
| Manage Server | 전용 서버의 기본 알림을 `Only @mentions`로 설정 |
| Manage Messages | `/clear`를 사용할 때만 필요 |

Discord thread에서는 일반 `Send Messages`와 별도로 `Send Messages in Threads`가 필요합니다. 부모 채널의 permission overwrite가 bot role을 막고 있지 않은지도 확인합니다.

### 3. 서버 구조와 ID

첫 설치에서는 bot 초대 후 AI 에이전트가 Discord API로 아래 구조를 만드는 것이 기본입니다.

1. `AI Agent Operator` 역할을 만들고 connector를 사용할 사람에게 부여합니다. 기존 설치의 `Codex Operator` 역할은 그대로 재사용할 수 있습니다.
2. 컴퓨터마다 AI agent/admin parent 채널을 만듭니다. 예: `#mac-agent-admin`, `#b200-agent-admin`.
3. Claude Code를 쓸 컴퓨터에는 별도 parent 채널을 만듭니다. 예: `#mac-claude-code`.
4. bot role과 Operator role의 channel permission overwrite를 설정합니다.
5. API 응답의 Guild/Role/Channel ID를 connector 설정에 직접 사용합니다.
6. 전용 private 서버라면 서버 기본 알림을 `Only @mentions`로 설정합니다. 진행 메시지는 mention하지 않고 질문·권한·완료·실패만 Operator role을 mention합니다. 개인별 channel override는 API로 바꾸지 못하므로 기존 override가 확인될 때만 사용자에게 수동 변경을 요청합니다.

bot permission이 부족하거나 기존 수동 구성을 재사용할 때만 Discord `사용자 설정 > 고급 > 개발자 모드`를 켜고 서버, 역할, 각 채널을 우클릭해 ID를 복사하도록 안내합니다.

Slash command는 bot 시작 시 대상 guild에 등록됩니다. 보이지만 실행되지 않는다면 channel ownership filter, guild ID, bot permission, command 재등록 로그 순서로 확인합니다.

## 코드 구조와 소유권

AI 에이전트는 기능을 수정하기 전에 아래 경계를 확인해야 합니다.

| 경로 | 책임 |
| --- | --- |
| `apps/connect-cli/src/index.ts` | setup/install/start CLI, bot/worker process supervisor |
| `apps/connect-cli/src/config.ts` | `.connect/config.json`, `.env` 생성과 Direct/Hub config schema |
| `apps/discord-bot/src/index.ts` | Discord gateway 조립, polling, durable request restore |
| `apps/discord-bot/src/discordClient.ts` | discord.js client, intents, message/interaction adapter, channel/thread API |
| `apps/discord-bot/src/messageHandler.ts` | 채널별 FIFO, steering, approval, user question, agent 요청 전체 orchestration |
| `apps/discord-bot/src/agentSettings.ts` | Codex/Claude 공통 model·effort 값, 기본값, 정규화 규칙 |
| `apps/discord-bot/src/agentSettingsController.ts` | main 기본값과 thread override의 공통 런타임 상태·영속화 연결 |
| `apps/discord-bot/src/agentCompletionAnswer.ts` | 두 에이전트 완료 알림의 답변 preview, 긴 답변, 첨부 전처리 |
| `apps/discord-bot/src/agentSurvey.ts` | 최종·중간 미디어 설문 블록 parsing과 선택지 정규화 |
| `apps/discord-bot/src/commandRouter.ts` | 일반 텍스트와 slash command를 내부 route로 분류 |
| `apps/discord-bot/src/applicationCommands.ts` | Discord slash command 선언·등록 |
| `apps/discord-bot/src/i18n.ts` | Discord outbound payload와 modal의 UI 문구 locale 적용, 사용자/agent 본문 보호 |
| `apps/discord-bot/src/responses.ts` | 공통 agent Discord payload, embed, 답변 분할, 첨부 출력 형식과 Codex 전용 승인 UI |
| `apps/discord-bot/src/directControlClient.ts` | Direct mode bot에서 worker/runner로 요청 연결 |
| `apps/discord-bot/src/directWorkerClient.ts` | worker spool polling, progress/approval/user-input 왕복 |
| `apps/discord-bot/src/durableRequestStore.ts` | bot gateway 재시작을 견디는 Discord 요청 큐 |
| `apps/discord-bot/src/agentRelayBridge.ts` | agent 최종 공개 답변과 파일을 private relay callback으로 변환 |
| `apps/relay-bot/src/index.ts` | Coordinator Discord gateway, slash command와 control channel 복구 |
| `apps/relay-bot/src/coordinator.ts` | 제한된 A/B turn state machine, 종료 합의와 최종 mention |
| `apps/relay-bot/src/store.ts` | Coordinator durable conversation state |
| `apps/local-agent/src/directWorker.ts` | bot과 독립된 실행 worker, queue-key 직렬화, graceful drain |
| `apps/local-agent/src/directWorkerStore.ts` | `.connect/worker` job/event/approval/user-input/result 저장 |
| `apps/local-agent/src/codexAppServerRunner.ts` | Codex app-server JSON-RPC, resume/fork/steer/interrupt/approval/question |
| `apps/local-agent/src/codexRunner.ts` | 호환용 `codex exec` runner와 JSONL progress parsing |
| `apps/local-agent/src/claudeRunner.ts` | Claude Code headless stream-json, resume/fork, model/effort, 권한 모드 |
| `apps/discord-bot/src/codexTaskNotifications.ts` | Codex native transcript 완료 알림 |
| `apps/discord-bot/src/codexTranscriptSync.ts` | Desktop/IDE transcript를 Discord에 on-chat/realtime 반영 |
| `apps/discord-bot/src/claudeSessionSync.ts` | 외부 Claude session 탐색, cache, Discord thread 연결 |
| `apps/discord-bot/src/incomingAttachments.ts` | Discord CDN 첨부 다운로드, 제한, TTL 정리 |
| `packages/codex-adapter` | Codex session index/thread state/transcript parser |
| `packages/core/src/locales` | locale registry와 언어별 UI catalog |
| `packages/core` | domain model과 shell command safety policy |

### 주요 실행 흐름

```text
Discord message
  -> discordClient
  -> messageHandler channel queue
  -> durableRequestStore
  -> directControlClient
  -> directWorkerClient
  -> .connect/worker job spool
  -> directWorker
  -> Codex app-server 또는 Claude Code
  -> progress / approval / question / result event
  -> Discord thread
```

일반 후속 메시지는 활성 Codex app-server 또는 Claude Code stream-json turn이 있으면 FIFO보다 먼저 steering으로 전달됩니다. `/queue prompt:`만 별도 다음 turn을 보장합니다.

공통 계층에는 agent 종류 판별, model·effort 설정, Discord 진행/결과 표시, 완료 답변과 첨부 처리를 둡니다. Codex app-server와 Claude Code stream-json은 공통 steering·interrupt 계약을 제공하지만, approval·user question은 Codex app-server에만 남습니다. 새 기능을 추가할 때 이름만 Codex인 공통 helper를 다시 만들지 말고, 두 agent가 같은 입출력 계약을 갖는지 먼저 확인합니다.

### 영속 상태와 재시작 의미

- `.connect/config.json`: token을 포함한 runtime config
- `.env`: runtime environment와 secret
- `.connect/state.json`: channel/session mapping, agent parent 기본값과 thread override, sync, schedule, notification 상태
- `.connect/discord-queue`: Discord에서 접수한 durable 요청
- `.connect/worker/jobs`: worker job, progress, approval, user question, result
- `.connect/incoming-attachments`: Discord에서 받은 임시 파일
- `.connect/answer-copies`: `답변 복사` 버튼이 재시작 후에도 동작하도록 보관하는 최종 답변 원문 캐시
- `$CODEX_HOME`: Codex native session/thread/transcript
- `~/.claude/projects`: Claude Code native session log

bot gateway가 죽어도 worker는 계속 실행되고 새 gateway가 같은 request ID와 worker event cursor로 재연결합니다. worker가 강제 종료되면 그 worker의 자식인 Codex/Claude/명령 프로세스도 중단될 수 있습니다.

`.connect/discord-queue`와 `.connect/worker`에는 복구를 위해 사용자 prompt, 역할 ID, 진행 내용과 결과가 평문으로 저장됩니다. store는 POSIX에서 directory `0700`, file `0600`을 강제하고, schema가 깨진 항목을 각 `dead-letter` directory로 격리합니다. Discord durable queue는 완료 전달 후 즉시 삭제하며 미완료 항목은 기본 7일 TTL, 1,000개, 전체 64MiB, 요청당 4MiB로 제한합니다. 첨부파일 본체는 `.connect/incoming-attachments`에 별도로 저장되고 queue에는 metadata와 local path만 들어가므로 이 JSON 제한에 포함되지 않습니다. `CONNECT_DISCORD_QUEUE_TTL_MS`, `CONNECT_DISCORD_QUEUE_MAX_REQUESTS`, `CONNECT_DISCORD_QUEUE_MAX_BYTES`, `CONNECT_DISCORD_QUEUE_MAX_REQUEST_BYTES`로 조정하고 `0`이면 해당 제한을 끕니다.

Connector 자체 암호화나 content redaction은 복구할 원문을 바꾸므로 제공하지 않습니다. OS full-disk encryption을 사용하고 `.connect`를 Dropbox, OneDrive, iCloud Drive, Google Drive, Syncthing, network share와 자동 backup 대상 밖에 둡니다. dead-letter도 민감 상태로 취급하며 문제 확인 후 안전하게 삭제합니다.

## 핵심 기능

- Discord 관리자 채널에서 로컬 컴퓨터의 파일 구조를 탐색하고 shell 명령을 실행합니다.
- Discord에서 Codex 또는 Claude Code에 자연어로 요청하고 진행 상황과 최종 답변을 받습니다.
- 두 agent의 공개 작업 설명을 선택한 locale의 진행 상태와 함께 표시합니다.
- Codex 또는 Claude Code가 최종 답변에 로컬 이미지나 `codex-discord-send` 첨부 블록을 포함하면 Discord 메시지에 파일로 첨부합니다.
- 활성화한 agent별 부모 채널과 session thread를 분리해, 둘을 동시에 사용해도 요청이 해당 agent로 라우팅됩니다.
- Codex workspace와 native session을 Discord 카테고리/채널로 동기화하고, Claude Code session도 전용 부모 채널 아래 thread로 연결합니다.
- `sync` 기본값은 세션 선택 UI입니다. 전체 동기화는 `sync all` 또는 `/sync-all`로 명시해야 합니다.
- Codex thread state에서 활성으로 확인된 앱 세션만 가져옵니다.
- 보관 세션, sub-agent, `codex exec`/CLI 일회성 세션, thread state 미확인 세션은 sync에서 제외합니다.
- 동기화된 세션 채널에는 최근 대화 맥락을 일부 올려서 이어서 대화할 수 있게 합니다.
- 동기화된 세션 채널은 `채팅 시작 시 동기화` 또는 `실시간 동기화` 모드 중 선택할 수 있습니다.
- `실시간 동기화` 모드에서는 Codex Desktop에서 먼저 시작된 세션 진행 상황도 기본 약 5초 주기로 Discord에 반영됩니다.
- Codex 또는 Claude Code 작업 완료를 감지하면 세션별 Discord 스레드에 operator role을 멘션해 알립니다.
- Discord에서 시작한 agent 작업은 최종 답변 메시지와 완료 알림이 중복되지 않도록 해당 완료 알림 한 번만 답변 본문을 생략합니다.
- Codex가 명령 실행, 파일 변경, 추가 권한을 요청하면 Discord 버튼으로 이번 턴 허용, 세션 동안 허용, 거절, 취소를 선택할 수 있습니다.
- Codex가 `request_user_input`으로 사용자 판단을 요청하면 operator role을 멘션해 질문하고, 같은 스레드의 다음 일반 답변을 실행 중인 turn에 그대로 돌려보냅니다.
- Discord 버튼/드롭다운으로 파일 이동, 파일 보기, Git 확인, 테스트 실행과 agent 리뷰/수정 요청을 처리합니다.
- Git 충돌 표식과 공백 오류를 Discord 드롭다운의 `Git 충돌 점검`으로 바로 확인할 수 있습니다.
- `유지보수` 패널에서 `봇 개발 채팅`, `타입체크`, `테스트 실행`, `명령어 재등록`, `봇 재시작`까지 이어갈 수 있습니다.
- Discord 안에서 slash command 재등록과 봇 재시작을 요청할 수 있습니다.
- 관리자 채널에서 `/clear count:<숫자>` 또는 `clear <개수>`로 운영 채널 메시지를 정리할 수 있습니다. 전체 정리는 확인 명령이 필요합니다.

Agent 요청 timeout은 기본 5시간입니다. 하위호환 환경변수 `CONNECT_CODEX_PROMPT_TIMEOUT_MS`에 millisecond 값을 넣어 Codex와 Claude Code 요청에 공통 적용할 수 있고, `0`으로 설정하면 전체 agent 요청 timeout을 끕니다.

## 구조

기본 사용 방식은 **Direct mode**입니다. Direct mode는 외부 Control API를 열지 않고, 같은 컴퓨터에서 Discord gateway와 실행 worker를 독립 프로세스로 실행합니다.

```text
Discord Server
  ├─ Admin / Codex Parent (Codex 활성화 시)
  │   ├─ sync / 파일 탐색 / shell / Codex session thread
  │   └─ 봇 reload / 상태 확인 / 삭제 미리보기
  └─ Claude Code Parent (Claude Code 활성화 시)
      ├─ Claude Code Session Thread
      └─ Claude Code Session Thread

Local Computer
  ├─ Agent state: ~/.codex and/or ~/.claude
  ├─ Project workspace
  └─ AI Agent Discord Connector
      ├─ Discord Bot: 메시지, 버튼, 알림
      ├─ Direct Worker: shell, Codex, Claude Code 실행
      └─ .connect/: durable 요청, job 결과, 연결 상태
```

Direct mode에서는 `Discord Bot -> durable queue -> Direct Worker`로 이 컴퓨터를 제어합니다. Discord bot만 재시작해도 worker와 이미 실행 중인 Codex/Claude Code 하위 프로세스는 계속 동작하며, 새 bot이 같은 request ID로 진행 이벤트, 권한 요청, 사용자 질문, 최종 결과에 다시 연결됩니다. 컴퓨터나 worker 자체가 강제 종료되면 실행 중 job은 실패 처리되지만 아직 시작하지 않은 요청은 디스크에 남아 다음 worker가 이어서 실행합니다.

같은 Discord bot token을 여러 컴퓨터에서 동시에 실행할 수도 있습니다. 이 경우 각 인스턴스의 admin/session 채널 ID가 서로 겹치지 않아야 하며, 봇은 담당하지 않는 채널의 일반 메시지, slash command, 버튼, 셀렉트, 모달 interaction을 무시합니다.

여러 컴퓨터를 한 Discord 서버에서 관리하는 **Hub mode**도 있지만, 현재는 실험적 기능입니다. Control API와 Local Agent를 추가로 실행해야 하고, 네트워크로 명령 실행 경로가 넓어지므로 보안 위험이 Direct mode보다 큽니다.

## 빠른 시작

### 1. 설치

이 fork는 기능 수정과 서비스 운영을 전제로 소스에서 설치합니다.

```bash
git clone https://github.com/kwonminki/ai-agent-discord-connector.git
cd ai-agent-discord-connector
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

SSH key가 설정돼 있으면 아래 주소를 사용할 수 있습니다.

```bash
git clone git@github.com:kwonminki/ai-agent-discord-connector.git
```

소스 checkout에서는 package script로 CLI를 실행합니다.

```bash
pnpm connect status
```

### 2. Direct mode 설정

단일 컴퓨터를 Discord와 바로 연결하는 Direct mode가 기본 사용 방식입니다.

```bash
pnpm connect install --direct
```

영어 UI로 설치할 때는 locale을 명시합니다.

```bash
pnpm connect install --direct --locale en
```

대화형 설치를 시작하면 각 값의 위치가 먼저 출력되고, 다음 값을 순서대로 입력받습니다.

- Discord bot token: [Discord Developer Portal](https://discord.com/developers/applications)에서 앱을 선택하고 `Bot > Reset Token/Copy`에서 가져옵니다. Public Key와 OAuth2 Client ID는 입력하지 않습니다.
- Discord guild/server ID: Discord `사용자 설정 > 고급 > 개발자 모드`를 켠 뒤 서버 아이콘을 우클릭하고 `서버 ID 복사`를 선택합니다.
- Operator role ID 목록: `서버 설정 > 역할`에서 connector 사용을 허용할 역할의 메뉴를 열어 `역할 ID 복사`를 선택합니다. 여러 역할은 쉼표로 구분합니다.
- AI agent/admin 채널 ID: 서버별 전용 agent 관리 채널을 우클릭하고 `채널 ID 복사`를 선택합니다.
- Claude Code 채널 ID: Claude Code를 활성화할 때 같은 서버의 전용 Claude Code 채널을 우클릭하고 `채널 ID 복사`를 선택합니다. Codex만 사용할 때는 비워둘 수 있습니다.
- 연결할 workspace root
- 컴퓨터 이름과 workspace 표시 이름
- Codex를 활성화할 때 Codex home 경로, 보통 `$HOME/.codex`

서버와 채널 ID를 복사하려면 Discord Developer Mode가 필요합니다. AI agent/admin 채널과 활성화한 Claude Code 채널은 서로 다른 채널이어야 하며, 같은 bot token을 여러 컴퓨터에서 쓸 때는 컴퓨터별 채널 ID도 겹치면 안 됩니다. Codex만, Claude Code만, 둘 다 중 어느 구성이든 가능하고 고정된 메인 agent는 없습니다. 자세한 ID 복사 방법은 [Discord 공식 안내](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID)를 참고하세요.

비대화형으로도 설정할 수 있습니다.

```bash
pnpm connect install --direct \
  --locale ko \
  --token "DISCORD_BOT_TOKEN" \
  --guild-id "DISCORD_GUILD_ID" \
  --role-ids "ROLE_ID_1,ROLE_ID_2" \
  --channel-id "AGENT_ADMIN_CHANNEL_ID" \
  --claude-channel-id "CLAUDE_CODE_CHANNEL_ID" \
  --workspace-root "$PWD" \
  --workspace-name "Workspace"
```

상위 폴더 이동을 허용하면서 특정 프로젝트 폴더에서 시작하려면 workspace root를 더 넓은 허용 루트로 잡고 `--initial-cwd`를 지정합니다.

```bash
pnpm connect install --direct \
  --workspace-root "/Users/me/projects" \
  --initial-cwd "/Users/me/projects/my-app" \
  --workspace-name "projects"
```

설정이 끝나면 `.connect/config.json`과 `.env`가 생성됩니다.

### Agent runner 설정

Codex를 활성화한 경우 세션 fork, 실행 중 steering, Discord 사용자 질문 응답을 사용하려면 runner가 반드시 `app-server`여야 합니다. Direct mode의 기본값도 `app-server`지만, LaunchAgent나 systemd처럼 별도 서비스로 실행할 때는 설정 누락을 쉽게 확인할 수 있도록 아래 값을 명시하는 것을 권장합니다.

```bash
CODEX_DISCORD_CODEX_RUNNER=app-server
```

systemd unit에서는 다음처럼 설정합니다.

```ini
Environment=CODEX_DISCORD_CODEX_RUNNER=app-server
```

`codex exec` 호환 모드에서는 `/fork`, 실행 중인 turn에 대한 일반 메시지 steering, `request_user_input` 질문 응답이 동작하지 않습니다. 예전 Codex CLI와의 호환성이 꼭 필요한 경우에만 `CODEX_DISCORD_CODEX_RUNNER=exec`를 명시하세요.

macOS와 Linux에서는 app-server가 임시 Unix domain socket을 사용합니다. Windows native에서는 Unix socket 대신 `127.0.0.1`의 임시 loopback WebSocket port를 자동 할당합니다. 이 port는 외부 interface에 bind하지 않으며 작업이 끝나면 app-server process와 함께 닫힙니다. Windows에서 `codex.exe app-server --listen ws://127.0.0.1:<port>`가 실패하면 `codex --version`과 `codex app-server --help`를 확인하고 CLI를 검증된 버전으로 맞춥니다.

Claude Code를 활성화한 경우 connector는 Claude Code의 headless stream JSON runner를 사용합니다. Codex runner 설정은 Claude Code 요청에 적용되지 않으며, Claude Code만 쓰는 설치에서는 Codex CLI와 app-server 검증을 생략합니다.

### 3. 봇 실행

```bash
pnpm connect start --direct
```

처음 실행 후 Discord 관리자 채널에서 `help`를 입력해 버튼과 명령어가 보이면 연결된 상태입니다.

## 운영 서비스 구성

foreground의 `pnpm connect start --direct`는 smoke test용입니다. 상시 운영에서는 반드시 bot과 worker를 분리합니다.

```text
Discord gateway service
  - Discord WebSocket, slash command, polling, 메시지 전송
  - 재시작해도 active agent process를 소유하지 않음

Direct worker service
  - Codex, Claude Code, shell child process 소유
  - macOS/Linux에서 SIGTERM 시 새 job을 받지 않고 active job drain
  - Windows Task Scheduler에서는 active job이 없을 때만 worker task 중지
```

공통 절대경로를 먼저 확인합니다.

```bash
pwd
command -v node
command -v codex
command -v claude
```

서비스 환경은 interactive shell의 `PATH`, shell rc, alias를 자동으로 상속하지 않습니다. `node`, `codex`, `claude`는 검증한 절대경로를 사용하세요.

### macOS LaunchAgent

repo의 `scripts/start-mac-direct.sh`는 source checkout 안에서 실행하면 repo root와 실행 파일을 자동 탐색합니다. macOS 개인정보 보호나 안정적인 절대경로가 필요해 wrapper를 다른 위치로 복사할 때는 `CODEX_DISCORD_REPO_ROOT`를 설정하거나 아래 형태의 machine-local wrapper를 만듭니다.

예시 경로:

```text
~/Library/Application Support/CodexDiscordConnector/start.sh
```

```bash
#!/bin/zsh
set -euo pipefail

REPO_ROOT="/absolute/path/to/ai-agent-discord-connector"
COMPONENT="${1:?bot or worker is required}"

export HOME="/Users/USER_NAME"
export PATH="/Users/USER_NAME/.local/bin:/Applications/ChatGPT.app/Contents/Resources:/Applications/Codex.app/Contents/Resources:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CONNECT_MODE="direct"
export CONNECT_LOCALE="ko"
export CONNECT_CONFIG_PATH="$REPO_ROOT/.connect/config.json"
export CONNECT_STATE_PATH="$REPO_ROOT/.connect/state.json"
export CONNECT_WORKER_ROOT="$REPO_ROOT/.connect/worker"
export CONNECT_DISCORD_QUEUE_ROOT="$REPO_ROOT/.connect/discord-queue"
export CODEX_DISCORD_CODEX_RUNNER="app-server"
export CODEX_DISCORD_CODEX_COMMAND="/Applications/ChatGPT.app/Contents/Resources/codex"
export CODEX_DISCORD_CLAUDE_COMMAND="/Users/USER_NAME/.local/bin/claude"

cd "$REPO_ROOT"

case "$COMPONENT" in
  bot)
    exec /opt/homebrew/bin/node --import tsx apps/discord-bot/src/index.ts
    ;;
  worker)
    exec /opt/homebrew/bin/node --import tsx apps/local-agent/src/directWorker.ts
    ;;
  *)
    exit 2
    ;;
esac
```

wrapper와 로그 디렉터리를 준비합니다.

```bash
chmod 700 "$HOME/Library/Application Support/CodexDiscordConnector/start.sh"
mkdir -p "$HOME/Library/Logs/codex-discord-connector"
```

bot LaunchAgent 핵심 설정:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.USER.codex-discord-connector.bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/USER/Library/Application Support/CodexDiscordConnector/start.sh</string>
    <string>bot</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key>
  <string>/Users/USER/Library/Logs/codex-discord-connector/bot.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/USER/Library/Logs/codex-discord-connector/bot.err.log</string>
</dict>
</plist>
```

worker plist는 label, component, log 이름을 `worker`로 바꾸고 긴 drain을 허용합니다.

```xml
<key>ExitTimeOut</key>
<integer>21600</integer>
```

LaunchAgent를 적용하고 확인합니다.

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.USER.codex-discord-connector.bot.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.USER.codex-discord-connector.worker.plist"
launchctl print "gui/$(id -u)/com.USER.codex-discord-connector.bot"
launchctl print "gui/$(id -u)/com.USER.codex-discord-connector.worker"
tail -f "$HOME/Library/Logs/codex-discord-connector/bot.out.log"
```

macOS 개인정보 보호 때문에 `Documents`, `Desktop`, 외장 디스크 접근이 service에서만 거부될 수 있습니다. wrapper와 실행 앱에 필요한 Full Disk Access를 검토하고, service user가 실제 workspace를 읽고 쓸 수 있는지 별도 명령으로 확인합니다.

### Ubuntu systemd

`USER_NAME`, `REPO_DIR`, Node/Codex/Claude 경로를 실제 값으로 바꿉니다. worker unit 예시:

```ini
[Unit]
Description=AI Agent Discord durable worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=USER_NAME
WorkingDirectory=REPO_DIR
Environment=HOME=/home/USER_NAME
Environment=PATH=/home/USER_NAME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=CONNECT_MODE=direct
Environment=CONNECT_LOCALE=ko
Environment=CONNECT_CONFIG_PATH=REPO_DIR/.connect/config.json
Environment=CONNECT_STATE_PATH=REPO_DIR/.connect/state.json
Environment=CONNECT_WORKER_ROOT=REPO_DIR/.connect/worker
Environment=CONNECT_DISCORD_QUEUE_ROOT=REPO_DIR/.connect/discord-queue
Environment=CODEX_DISCORD_CODEX_RUNNER=app-server
Environment=CODEX_DISCORD_CODEX_COMMAND=/absolute/path/to/codex
Environment=CODEX_DISCORD_CLAUDE_COMMAND=/absolute/path/to/claude
Environment=CODEX_DISCORD_CODEX_APPROVAL_POLICY=never
Environment=CODEX_DISCORD_CODEX_SANDBOX=danger-full-access
Environment=CONNECT_DIRECT_WORKER_POLL_INTERVAL_MS=5000
ExecStart=/absolute/path/to/node --import tsx apps/local-agent/src/directWorker.ts
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=infinity

[Install]
WantedBy=multi-user.target
```

bot unit 예시:

```ini
[Unit]
Description=AI Agent Discord gateway
After=network-online.target codex-discord-worker.service
Wants=network-online.target codex-discord-worker.service

[Service]
Type=simple
User=USER_NAME
WorkingDirectory=REPO_DIR
Environment=HOME=/home/USER_NAME
Environment=PATH=/home/USER_NAME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=CONNECT_MODE=direct
Environment=CONNECT_LOCALE=ko
Environment=CONNECT_CONFIG_PATH=REPO_DIR/.connect/config.json
Environment=CONNECT_STATE_PATH=REPO_DIR/.connect/state.json
Environment=CONNECT_WORKER_ROOT=REPO_DIR/.connect/worker
Environment=CONNECT_DISCORD_QUEUE_ROOT=REPO_DIR/.connect/discord-queue
Environment=CODEX_DISCORD_CODEX_RUNNER=app-server
Environment=CONNECT_TASK_NOTIFICATION_INTERVAL_MS=3000
Environment=CONNECT_TRANSCRIPT_SYNC_INTERVAL_MS=5000
ExecStart=/absolute/path/to/node --import tsx apps/discord-bot/src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

worker는 `.connect/worker/wake` 변경을 감시해 새 job, steering, 권한 응답과 agent 질문 응답을 즉시 처리합니다. `CONNECT_DIRECT_WORKER_POLL_INTERVAL_MS`의 기본 5초는 file watch 누락이나 미지원 filesystem을 위한 fallback일 뿐이며, idle 상태에서 250ms 전체 spool scan을 반복하지 않습니다. 시작할 때 빈 job/control spool을 한 번 생성해 idle poll에서 `ENOENT` 예외도 만들지 않습니다. 진행 event JSONL은 `mtime`과 크기가 같으면 다시 읽지 않고 append된 byte range만 파싱합니다. managed Codex app-server는 turn 종료 후 실제 child exit를 확인하고, graceful timeout을 넘기면 강제 종료해 orphan process 누적을 막습니다.

설치와 확인:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-discord-worker codex-discord-bot
sudo systemctl status codex-discord-worker codex-discord-bot --no-pager
journalctl -u codex-discord-worker -u codex-discord-bot -f
```

### Windows Scheduled Tasks

Windows native 설치는 Windows PowerShell 5.1 이상 또는 PowerShell 7에서 실행합니다. Project가 WSL2 filesystem과 Linux toolchain에만 있다면 native 설치를 섞지 말고 WSL2 내부를 Ubuntu 인스턴스로 취급해 systemd 경로를 사용합니다. Windows filesystem의 project와 native Codex를 사용할 때만 이 절을 따릅니다.

먼저 같은 Windows user의 PowerShell에서 다음을 확인합니다.

```powershell
node --version
pnpm --version
codex --version
codex app-server --help
claude --version
```

`codex`와 `claude`는 서비스 환경에서 실행 가능한 native `.exe`를 권장합니다. 경로가 자동 탐지되지 않으면 사용자 환경에 `CODEX_DISCORD_CODEX_COMMAND`, `CODEX_DISCORD_CLAUDE_COMMAND`, `CODEX_DISCORD_NODE_COMMAND`를 검증한 절대경로로 설정합니다. 관리자 채널 shell은 기본적으로 `powershell.exe`이며 PowerShell 7을 쓰려면 `CONNECT_WORKSPACE_SHELL`을 `pwsh.exe` 절대경로로 설정합니다.

foreground smoke test:

```powershell
Set-Location C:\path\to\ai-agent-discord-connector
pnpm connect start --direct
```

검증 후 bot과 worker를 별도 로그인 Scheduled Task로 등록합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows-tasks.ps1 -StartNow

Get-ScheduledTask -TaskName "CodexDiscordConnector-*" |
  Get-ScheduledTaskInfo
Get-Content "$env:LOCALAPPDATA\CodexDiscordConnector\Logs\bot.log" -Tail 50
Get-Content "$env:LOCALAPPDATA\CodexDiscordConnector\Logs\worker.log" -Tail 50
```

등록 스크립트는 `CodexDiscordConnector-Bot`, `CodexDiscordConnector-Worker` 두 작업을 만들고 현재 Windows user가 로그인할 때 각각 실행합니다. 작업 이름을 구분해야 하면 `-TaskPrefix`를 사용합니다. bot task만 다시 시작할 때는 worker task와 PID를 건드리지 않습니다.

```powershell
Stop-ScheduledTask -TaskName "CodexDiscordConnector-Bot"
Start-ScheduledTask -TaskName "CodexDiscordConnector-Bot"
```

Task Scheduler의 `Stop-ScheduledTask`는 Unix `SIGTERM` drain과 같지 않고 process를 중단할 수 있습니다. Worker task는 active job이 0인지 확인한 뒤에만 stop/restart합니다. 로그인 전부터 동작해야 하는 headless Windows Server라면 사용자의 명시적 승인을 받고 전용 service account와 Windows service wrapper를 구성하며, account password를 문서·Discord·Git에 기록하지 않습니다.

### 업데이트와 재시작 정책

1. `git status`와 active queue/job을 확인합니다.
2. `git pull --ff-only` 또는 검토된 commit을 checkout합니다.
3. `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`를 실행합니다.
4. bot 전용 변경은 bot service만 재시작합니다.
5. worker/runner/store 변경은 worker에 `SIGTERM`을 보내 drain 후 재시작합니다.
6. active job을 즉시 포기해도 된다는 사용자 승인이 있을 때만 worker를 강제 종료합니다.

```bash
sudo systemctl restart codex-discord-bot
sudo systemctl restart codex-discord-worker
```

`git pull`만으로 이미 메모리에 로드된 process 코드가 바뀌지는 않습니다. 반대로 bot만 재시작하면 worker가 소유한 Codex/Claude 하위 프로세스는 계속 살아 있고 새 gateway가 durable event cursor로 재연결합니다.

## 신규 런칭 필수 체크리스트

이 절은 새 Mac/Windows/Ubuntu 인스턴스를 실제 Discord에 연결하기 전에 반드시 확인하는 운영 기준입니다.

### 실행 사용자와 native session 경로

- 서비스는 Codex/Claude를 실제 사용하는 것과 같은 OS user로 실행합니다.
- `HOME`, `CODEX_HOME`, `~/.claude/projects`가 interactive IDE/CLI와 서비스에서 같은 위치인지 확인합니다.
- root service로 띄워 사용자의 session 파일을 못 찾거나 root 소유 파일을 만드는 구성을 피합니다.
- Ubuntu system service의 `User=`, Mac LaunchAgent의 login user, Windows Scheduled Task의 principal을 명시적으로 확인합니다.
- Mac LaunchAgent는 해당 사용자가 로그인한 뒤 실행되는 user service입니다. 로그인 전부터 필요한 진짜 headless Mac daemon과는 성격이 다릅니다.
- Windows 기본 Scheduled Task도 해당 사용자의 로그인 세션에서 실행됩니다. native Codex/Claude state와 task principal이 같은 Windows user인지 확인합니다.

### 경로와 권한

- `workspaceRoot`는 agent가 접근할 수 있는 허용 범위입니다. 너무 좁으면 다른 프로젝트/GPU mount를 못 보고, 너무 넓으면 Discord에서 수정 가능한 범위가 커집니다.
- `initialCwd`는 실제 첫 작업 폴더여야 하고 `workspaceRoot` 내부에 있어야 합니다.
- service user로 workspace, `.connect`, incoming attachment root에 read/write 가능한지 확인합니다.
- macOS는 터미널에서 성공해도 LaunchAgent에서 Documents/Desktop/외장 디스크 접근이 막힐 수 있습니다.
- Ubuntu mount, NFS, NAS, Docker bind mount는 service user UID/GID와 ACL을 확인합니다.
- GPU는 connector 밖의 같은 service user에서 먼저 `nvidia-smi`가 성공해야 합니다. container라면 `/dev/nvidia*`와 runtime GPU 설정을 별도로 노출합니다.

### Discord ownership

- guild ID와 활성화한 agent parent channel ID가 실제 설치 대상과 일치해야 합니다.
- Claude Code를 활성화했다면 AI agent/admin parent와 Claude parent는 서로 다른 ID여야 합니다.
- 같은 bot token의 다른 머신 config와 channel ID가 겹치지 않아야 합니다.
- Operator role을 실제 사용자에게 부여하고, channel overwrite에서 bot role과 Operator role이 허용되는지 확인합니다.
- Message Content Intent, thread permission, `applications.commands` scope를 확인합니다.
- 처음에는 `/status`와 `/chat-new`만 시험한 뒤 shell/GPU/full-access 작업을 허용합니다.

### Secret과 상태 파일

- `.env`와 `.connect/config.json`에는 token이 들어갈 수 있으므로 `chmod 600`을 권장합니다.
- `.connect/discord-queue`와 `.connect/worker`가 POSIX에서 `0700`, 이 store가 생성하거나 읽는 JSON/JSONL이 `0600`인지 확인합니다. connector는 queue/worker store를 열 때 이 권한을 다시 강제합니다.
- repo와 `.connect`가 cloud sync, network share 또는 신뢰하지 않는 backup 범위 안에 있으면 런칭 전에 안전한 local 경로로 옮깁니다.
- `.gitignore`에 `.env`, `.env.*`, `.connect/`, log, SQLite가 제외되는지 확인합니다.
- setup 후 `git status --short`에 secret/state 파일이 나타나면 런칭을 중단하고 ignore를 수정합니다.
- 기존 `.connect/state.json`, `.connect/discord-queue`, `.connect/worker`를 무심코 삭제하지 않습니다.
- 다른 머신의 `.connect` 디렉터리를 복사하지 않습니다. channel/session/job mapping이 충돌할 수 있습니다.

### Process topology

- Direct mode는 외부 inbound port가 필요 없습니다. Discord와 Codex/Claude API로 나가는 HTTPS/WebSocket만 허용하면 됩니다.
- bot과 worker는 별도 service/PID여야 합니다.
- 같은 `CONNECT_WORKER_ROOT`에 worker를 두 개 띄우지 않습니다. worker lock 오류는 중복 실행 신호입니다.
- 같은 channel set을 담당하는 Discord gateway를 두 개 띄우지 않습니다.
- launch order는 worker 먼저, bot 다음을 권장합니다.
- bot과 worker가 같은 repo checkout과 호환되는 commit/dependency를 사용해야 합니다.

### 첫 실행 검증

1. worker ready 로그와 PID를 확인합니다.
2. bot ready 로그와 Discord 사용자명을 확인합니다.
3. `/status`에서 computer, workspace, cwd, runner 정보를 확인합니다.
4. 활성화한 agent마다 `/chat-new`로 test thread를 만들고 짧은 파일 읽기 요청을 실행합니다.
5. 활성화한 Codex와 Claude Code 각각에서 실행 중 일반 메시지가 현재 turn에 steering되는지 확인합니다.
6. 활성화한 agent마다 `/queue prompt:`가 별도 다음 turn으로 실행되는지 확인합니다.
7. `/howtouse` 후 작은 텍스트/이미지 파일을 양방향으로 전송합니다.
8. Codex를 활성화했다면 `request_user_input` 질문 또는 approval flow를 한 번 확인합니다. Claude Code만 활성화했다면 이 단계는 건너뜁니다.
9. bot service만 재시작하고 worker PID가 유지되며 결과가 Discord로 돌아오는지 확인합니다.
10. 로그에 token, 민감 경로 내용, 반복 재시작이 없는지 확인합니다.

첫 Codex/Claude background scan은 과거 알림 폭주를 막기 위해 baseline만 기록할 수 있습니다. 런칭 직후 옛 완료 알림이 오지 않는 것을 장애로 오판하지 말고, baseline 이후 새 작업으로 검증합니다.

## 업데이트 필수 체크리스트

### 1. 변경 범위 분류

업데이트 전 현재/대상 commit과 파일 목록을 확인합니다.

```bash
git status --short
git rev-parse --short HEAD
git fetch origin
git diff --name-only HEAD..origin/master
```

대략적인 restart 범위:

| 변경 위치 | 필요한 조치 |
| --- | --- |
| `README.md`, `docs/`만 | service 재시작 불필요 |
| `apps/discord-bot/`만 | bot restart |
| slash command 선언 | bot restart 후 command 재등록 확인 |
| `apps/local-agent/`, worker store/runner | worker graceful drain 후 restart |
| 공유 type, `packages/`, config schema | bot과 worker 모두 restart |
| `package.json`, `pnpm-lock.yaml` | install/test 후 bot과 worker 모두 restart |
| Codex/Claude CLI 버전 변경 | protocol smoke test 후 순차 rollout |

실제 import 관계가 표보다 우선입니다. 예를 들어 bot이 local-agent type/store를 직접 import하므로 shared 파일 변경은 양쪽 process에 영향을 줄 수 있습니다.

### 2. active work와 queue 확인

- Discord 각 관련 thread에서 `/status`를 확인합니다.
- `.connect/worker/jobs/*/state.json`의 `running`/`queued` job을 확인합니다.
- `.connect/discord-queue`에 복구 대기 요청이 있는지 확인합니다.
- bot PID, worker PID, Codex/Claude child process를 기록합니다.
- 같은 bot token을 쓰는 다른 서버의 업데이트 상태도 기록합니다.

active job이 있으면 세 선택지를 사용자에게 명확히 제시합니다.

- **bot만 즉시 재시작**: worker 작업은 유지됩니다.
- **worker drain**: 현재 작업 완료 후 새 worker로 교체됩니다. 그동안 새 요청은 disk queue에 남을 수 있습니다.
- **worker 강제 종료**: 현재 agent와 하위 명령이 끊기며 active job은 실패할 수 있습니다.

사용자의 명시 승인 없이 세 번째를 선택하지 않습니다.

### 3. 코드와 dependency 적용

dirty worktree를 덮어쓰지 않습니다. 자동 배포는 fast-forward 가능한 깨끗한 checkout을 기본으로 합니다.

```bash
git pull --ff-only origin master
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
git diff --check
```

테스트가 실패하면 running service를 새 코드로 재시작하지 않습니다. CLI protocol 변경처럼 환경 의존 실패라면 실패한 명령, Node/pnpm/Codex/Claude 버전과 정상 서버 차이를 기록합니다.

### 4. 안전한 적용 순서

bot과 worker를 모두 바꿀 때 권장 순서:

1. 새 코드와 dependency를 disk에 준비하고 검증합니다.
2. bot을 재시작해 새 gateway 코드를 적용합니다.
3. worker에 정상 `SIGTERM`을 보내 drain을 시작합니다.
4. active job 완료 후 service manager가 새 worker를 올리는지 확인합니다.
5. 새 PID와 ready log를 확인합니다.
6. 새 짧은 요청으로 end-to-end 검증합니다.

Mac 예시:

```bash
launchctl kickstart -k "gui/$(id -u)/com.USER.codex-discord-connector.bot"
launchctl kill SIGTERM "gui/$(id -u)/com.USER.codex-discord-connector.worker"
```

Ubuntu 예시:

```bash
sudo systemctl restart codex-discord-bot
sudo systemctl restart codex-discord-worker
```

Windows 예시:

```powershell
Stop-ScheduledTask -TaskName "CodexDiscordConnector-Bot"
Start-ScheduledTask -TaskName "CodexDiscordConnector-Bot"
# Worker는 /status에서 active job이 0일 때만 같은 순서로 재시작합니다.
```

`systemctl restart worker`는 `TimeoutStopSec=infinity`에서 active job이 끝날 때까지 기다릴 수 있습니다. 별도 배포 shell의 timeout으로 다시 `SIGKILL`하지 않도록 주의합니다.

### 5. 강제 업데이트

Discord의 `reload restart force confirm`은 gateway를 즉시 재시작하는 명령이며 worker를 강제로 죽이는 명령이 아닙니다. worker까지 즉시 중단하려면 OS service manager에서 명시적으로 강제 종료해야 합니다.

강제 worker 종료 전 기록:

- active request와 session ID
- cwd와 child PID
- queue에 남은 요청
- 중간 생성 파일과 Git 상태
- 사용자 승인

강제 종료 후에는 worker store가 이전 running job을 실패 처리할 수 있습니다. 새 요청을 보내기 전에 `/status`, job state, Git/filesystem 상태를 확인합니다.

### 6. 반복 재시작 방지

- 정식 LaunchAgent/systemd service 또는 Windows Scheduled Task 외에 임시 refresh service를 만들지 않습니다.
- 특히 `launchctl submit`으로 만든 `worker-refresh-*`가 KeepAlive worker와 경쟁하지 않는지 확인합니다.
- ready 로그가 몇 초마다 반복되면 crash loop 또는 중복 supervisor를 먼저 찾습니다.
- service의 `WorkingDirectory`, Node 경로, `tsx`, config path, file permission 오류를 확인합니다.
- bot과 worker를 동시에 감싸는 또 다른 process supervisor를 service manager 위에 중복으로 두지 않습니다.

### 7. 여러 서버 순차 rollout

같은 Discord app을 여러 머신에서 사용할 때 한 서버에서 먼저 canary 검증합니다.

1. 각 host의 commit, Node, pnpm, Codex, Claude 버전을 표로 기록합니다.
2. 작업이 없는 host 하나를 먼저 업데이트합니다.
3. `/status`, `/fork`, steering, queue, 파일 입출력, 완료 알림을 확인합니다.
4. 나머지 host를 하나씩 업데이트합니다.
5. 각 host의 parent channel에서 ready/ownership을 확인합니다.

서버별 CLI 버전 차이는 app-server와 stream-json 호환 문제를 만들 수 있습니다. connector commit만 같다고 동일 동작을 가정하지 않습니다.

### 8. rollback

rollback도 update와 같은 process 경계를 따릅니다.

```bash
git log --oneline -10
git checkout <last-known-good-commit>
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

- `.connect`와 `.env`는 삭제하거나 과거 Git 상태로 되돌리지 않습니다.
- queued/running job이 새 schema로 이미 기록됐다면 구버전 worker가 읽을 수 있는지 먼저 확인합니다.
- schema/event 호환이 불명확하면 queue가 빌 때까지 기다린 뒤 rollback합니다.
- bot-only rollback은 worker를 건드리지 않습니다.
- rollback 후 commit, service PID, ready log, smoke test 결과를 남깁니다.

## GitHub 버전 공지 설정

버전 공지는 connector process가 아니라 `.github/workflows/release-announcement.yml`의 GitHub Actions가 담당합니다. `v1.0`, `v1.2.3`, `v2.0-beta.1` 같은 annotated tag가 push될 때만 해당 tag가 가리키는 commit을 Discord webhook으로 전송합니다. 일반 `master` commit은 공지하지 않으므로 커밋과 tag push가 중복 알림을 만들지 않습니다. 따라서 여러 컴퓨터에서 같은 bot application을 실행해도 polling이나 leader 선출이 필요하지 않습니다.

이 기능은 선택 사항이며 **컴퓨터가 아니라 GitHub 저장소마다 한 번만** 설정합니다. 단순 upstream clone에는 설정하지 않습니다. 사용자가 자신의 fork 또는 독립 저장소에서 공지를 원한다고 명시했을 때만 진행합니다.

필수 입력과 권한:

- 대상 GitHub `OWNER/REPOSITORY`
- Discord 공지 채널 ID
- 기존 `DISCORD_BOT_TOKEN`
- 공지 채널에서 bot의 `Manage Webhooks` 권한
- GitHub repository secret을 설정할 수 있는 인증과 저장소 write 권한

설정 절차:

1. `.github/workflows/release-announcement.yml`과 `scripts/release-announcement.mjs`가 현재 branch에 있는지 확인합니다.
2. `gh auth status`로 GitHub CLI 인증을 확인합니다. 인증이 없으면 token을 요구하지 말고 사용자가 직접 `gh auth login`을 완료하게 합니다. `gh`가 없으면 GitHub Settings의 `Secrets and variables > Actions` 수동 절차를 안내합니다.
3. bot token을 출력하지 않은 상태로 Discord `POST /channels/{channel.id}/webhooks`를 호출해 `AI Agent Releases` incoming webhook을 생성합니다. 이 endpoint에는 target channel의 `Manage Webhooks` 권한이 필요합니다.
4. 먼저 동일 이름의 기존 webhook을 확인하고, 재사용 가능 여부가 불명확하면 중복 생성 전에 사용자에게 확인합니다.
5. 응답의 webhook ID와 token으로 만든 URL을 shell history, 임시 파일, `.env`, 로그, 채팅에 남기지 않습니다.
6. URL을 표준 입력으로 전달해 대상 저장소의 repository Actions secret `DISCORD_RELEASE_WEBHOOK_URL`을 설정합니다. 예: `printf '%s' "$WEBHOOK_URL" | gh secret set DISCORD_RELEASE_WEBHOOK_URL --repo OWNER/REPOSITORY`.
7. `gh secret list --repo OWNER/REPOSITORY`로 secret **이름만** 확인하고 workflow 파일을 확인합니다. 릴리스 커밋의 `package.json` 버전과 annotated tag가 일치하며 tag가 정확히 그 commit을 가리키는지 검증합니다. secret 값은 GitHub에서도 다시 읽어 보여주지 않습니다.
8. Coordinator를 사용하는 설치라면 `.connect/relay-config.json`의 `releaseChannelId`를 같은 공지 channel ID로 설정하고 Coordinator service만 재시작합니다.
9. 모든 Connector가 같은 private control channel과 Coordinator bot user ID를 신뢰하는지, `computerId`가 서로 다른지 확인합니다. 서버별 대표 유지보수 agent는 `direct.maintenanceAgent` 또는 `CONNECT_MAINTENANCE_AGENT`로 하나만 선택합니다. 최초 discovery에서 선택한 agent 부모 채널 아래에 locale별 전용 업데이트 스레드가 자동 생성되고 이후 재사용되는지 확인합니다.
10. 릴리스할 때 버전 커밋을 push한 뒤 같은 commit에 annotated tag를 만들고 push합니다. 예: `git tag -a v1.3.0 -m "v1.3.0 Automatic server updates"` 후 `git push origin v1.3.0`.
11. 테스트용 가짜 tag나 버전 공지는 사용자가 요청한 경우에만 보냅니다.

하나의 repository secret에는 webhook URL 하나만 저장할 수 있습니다. 여러 fork가 같은 Discord webhook을 각각 등록하면 각 저장소의 버전 push가 별도 공지를 만들 수 있으므로, 실제 릴리스를 발행하는 저장소 하나에만 설정하는 것을 권장합니다.

원클릭 업데이트 버튼을 누르면 Coordinator가 private control channel에 일회성 discovery를 보내고, 현재 온라인인 Connector만 응답합니다. 각 Connector는 선택된 agent 부모 채널 아래에서 locale별 전용 업데이트 스레드를 상태와 Discord 양쪽에서 확인해 재사용하고, 없거나 삭제됐을 때만 다시 만듭니다. Coordinator는 `computerId`별로 이 전용 스레드 하나에만 요청하며 기존 사용자 작업 스레드로 fallback하지 않습니다. static channel 목록과 주기 polling을 추가하지 않습니다. 업데이트 prompt는 tag에서 peel한 exact release commit, clean/ff-only Git, lockfile 설치, gateway/worker 분리, active job의 graceful drain을 요구합니다. 오프라인 서버와 아직 전용 스레드를 등록하지 못한 구버전 Connector는 안전하게 건너뜁니다.

### Discord 채널과 알림 권장 설정

개인용 private Discord 서버에 컴퓨터별 관리자 채널과 Codex/Claude Code 세션 채널을 따로 만드는 구성을 권장합니다. 전용 서버에서는 설치 에이전트가 `Manage Server` 권한으로 `PATCH /guilds/{guild.id}`를 호출해 `default_message_notifications`를 `1`(`ONLY_MENTIONS`)로 설정하고 응답값을 검증합니다. 태그 없는 중간 진행 메시지는 알림 없이 쌓이고, 확인이 필요한 질문·권한 요청과 최종 완료·실패 메시지만 operator role 멘션으로 알림이 옵니다.

이 설정은 guild 전체 기본값이므로 공유 서버에서는 사용자 동의 없이 변경하지 않습니다. Discord 사용자가 직접 만든 채널별 notification override는 bot API로 읽거나 변경할 수 없고 서버 기본값보다 우선합니다. 서버 기본값 적용 뒤에도 특정 채널의 모든 메시지 알림이 오면 그 채널의 사용자 알림 설정만 수동으로 **멘션만**으로 되돌리게 합니다.

세션 채널이 많다면 전용 카테고리를 만들고 같은 알림 정책을 적용하면 관리하기 편합니다. operator role은 실제 알림을 받을 사용자에게만 부여하고, 각 컴퓨터의 봇 인스턴스에는 서로 겹치지 않는 관리자/세션 부모 채널 ID를 설정하세요.

### 자주 쓰는 명령어

| 명령어 | 용도 |
| --- | --- |
| `/status` | 현재 세션 연결, 실행 상태, 마지막 활동 시각과 대기열을 확인합니다. |
| `/fork` | 현재 Codex 또는 Claude Code 세션의 맥락을 복제해 새 Discord thread로 분기합니다. Codex에서는 `app-server`가 필요합니다. |
| `/howtouse [prompt]` | 현재 agent 세션에 Discord 첨부 송수신, 최종 미디어 설문, Codex `request_user_input` 중간 미디어 질문 형식을 전달합니다. Claude Code에는 중간 질문 왕복 미지원 안내를 전달합니다. `prompt`를 함께 주면 사용법 안내 뒤에 그 요청이 이어져 한 턴에 전달됩니다(텍스트로는 `/howtouse 결과 이미지를 보내줘`). |
| `/queue prompt:<요청>` | 현재 작업에 끼어들지 않고 다음 작업으로 실행할 요청을 예약합니다. |

## 버전 호환성

Codex CLI와 Claude Code의 headless/protocol 인터페이스는 버전에 따라 달라질 수 있습니다. 특히 이 connector는 Codex의 `app-server` JSON-RPC와 Claude Code의 stream JSON 출력을 사용하므로, 서버마다 버전이 크게 다르면 한 서버에서만 fork, resume, 진행 출력 또는 권한 설정이 실패할 수 있습니다.

2026-07-23 현재 개발 및 실제 Mac 서비스에서 확인한 기준은 다음과 같습니다. Windows code path는 플랫폼 독립 테스트를 통과하지만 실제 Windows host의 Codex/Claude 설치 방식과 정책이 다를 수 있으므로 첫 Windows 설치에서 아래 smoke test를 반드시 수행합니다.

| 구성 요소 | 지원 또는 확인 버전 | 메모 |
| --- | --- | --- |
| Node.js | `^20.19.0` 또는 `>=22.12.0` | Ubuntu와 Windows는 Node.js 22 LTS 권장 |
| pnpm | `9.15.0` | `packageManager`에서 고정 |
| Codex CLI | `codex-cli 0.145.0-alpha.18` 확인 | `app-server`, `thread/resume`, `thread/fork`, `turn/start`, `item/tool/requestUserInput` 사용 |
| Claude Code | `2.1.215` 확인 | `stream-json`, `--resume`, `--fork-session`, `--permission-mode` 사용 |

Codex와 Claude Code의 표에 적힌 값은 엄격한 최소 버전이 아니라 **검증 기준 버전**입니다. 더 최신 버전이 항상 호환된다는 뜻은 아닙니다. 여러 Mac, Windows, Ubuntu 머신을 운영할 때는 가능한 한 같은 CLI 버전을 맞추고, 운영체제별 한 대에서 먼저 connector smoke test를 통과시킨 뒤 나머지를 업데이트하세요.

각 머신에서 아래 결과를 함께 기록하면 호환 문제를 비교하기 쉽습니다.

```bash
node --version
pnpm --version
codex --version
claude --version
git -C /path/to/ai-agent-discord-connector rev-parse --short HEAD
```

CLI 업데이트 후에는 최소한 `where`, 짧은 Codex/Claude 요청, `/fork`, bot 재시작 후 실행 중 job 재연결을 확인하세요. 특정 서버에서만 문제가 생기면 정상 서버와 위 버전을 먼저 비교하고, 필요하면 해당 서버의 CLI를 마지막 정상 버전으로 되돌리세요. systemd나 Windows Task Scheduler가 interactive shell과 다른 실행 파일을 잡지 않도록 `CODEX_DISCORD_CODEX_COMMAND`와 `CODEX_DISCORD_CLAUDE_COMMAND`에는 검증한 실행 파일의 절대 경로를 설정하는 것이 안전합니다.

## 실험적 다중 컴퓨터 연결: Hub mode

Hub mode는 여러 컴퓨터를 한 Discord 서버에서 관리하기 위한 실험적 옵션입니다. 아직 테스트 중인 서브 기능이며, 보안 위험이 Direct mode보다 높습니다. 꼭 필요한 경우가 아니라면 Direct mode를 사용하세요.

Hub mode에서는 아래 컴포넌트를 함께 실행합니다.

- Discord Bot
- Control API
- Local Agent

위 구조는 여러 컴퓨터를 등록할 수 있게 해주지만, Control API와 Agent 연결 경로가 추가됩니다. 네트워크 노출, 인증 설정, 로그/명령 출력 관리, 운영자 role 관리가 모두 더 중요해집니다.

최소 권장 조건:

- 신뢰하는 private Discord 서버에서만 사용
- Control API를 공개 인터넷에 직접 노출하지 않기
- 방화벽, VPN, localhost 터널 등 별도 접근 제어 사용
- 각 컴퓨터의 workspace root를 필요한 범위로 제한
- 운영자 role을 최소 인원에게만 부여
- shell 명령 출력에 민감 정보가 섞이지 않는지 별도 점검

```bash
pnpm connect setup --hub
pnpm connect start --hub
```

```text
Discord Bot -> Control API -> Local Agent -> Local Computer
```

Direct mode와 달리 여러 컴퓨터를 등록하고 관리할 수 있습니다. 이 기능은 안정화 전까지 “테스트 중”으로 보고, 중요한 컴퓨터나 민감한 workspace에는 사용하지 않는 것을 권장합니다.

## Discord 사용법

### 관리자 채널

관리자 채널은 컴퓨터 제어용 채널입니다. 일반 메시지는 role 검사를 거친 뒤 shell 명령으로 처리됩니다.
Codex 대화는 이 채널에서 직접 실행하지 않고, `chat new` 또는 `sync`로 만든 세션 채널에서 진행합니다.

```text
help
where
ls
cd apps
cat README.md
chat new name:자유 메모
chat new current name:지금 폴더 작업
chat new cwd:/Users/me/project name:새 기능 구현
sync
sync status
reload
```

위험한 명령은 명시 확인이 필요합니다.

```text
confirm rm path/to/file
```

### Codex 세션 채널

`sync`로 만들어진 세션 채널은 Codex 대화방처럼 사용할 수 있습니다. 일반 메시지는 Codex에게 전달되고, shell 명령은 `!` 접두어를 붙입니다.

```text
이 세션에서 지금까지 한 일 요약해줘
다음 단계 구현해줘
review 보안 위험 위주
model gpt-5.4
!ls
!cat README.md
archive confirm
```

### 새 Codex 채팅 만들기

관리자 채널에서 새 Discord 채널을 만들고, 그 채널을 새 Codex 대기 세션으로 연결할 수 있습니다.

```text
chat new name:자유 메모
/chat-new location:general name:자유 메모
```

위 명령은 카테고리 없는 일반 Codex 채팅 채널을 만듭니다. 봇은 일반 채팅용 전용 폴더를 만들고, 새 채널에서 첫 메시지를 보내면 그때 실제 Codex 세션이 열립니다.
Discord 버튼으로 만들 때는 `새 일반 채팅` 또는 `현재 폴더 채팅`을 누르면 모달이 열립니다. 채널 이름과 첫 요청을 입력할 수 있고, 둘 다 비워도 채널만 먼저 만들 수 있습니다.

현재 Discord 채널의 작업 폴더에서 새 채팅을 시작하려면 `current`를 사용합니다. 특정 폴더에서 시작하려면 `cwd`를 지정합니다. 이 경우 해당 폴더 이름의 Discord 카테고리 아래에 채널이 생성됩니다.

```text
chat new current name:지금 폴더 작업
/chat-new location:current name:지금 폴더 작업
chat new cwd:/Users/me/project name:주간 보고서
/chat-new location:path name:주간 보고서 cwd:/Users/me/project category:true
```

`location:general` 또는 `cwd` 생략 기본값은 프로젝트 폴더와 분리된 일반 채팅입니다.

## Slash commands

봇은 시작 시 Discord-native slash command를 등록합니다. 명령어는 전역으로 보이지만, 실제 실행 가능 범위는 채널 모드로 나뉩니다. main/admin 채널에서 Codex 대화 명령을 실행하거나, session 채널에서 동기화/봇 관리 명령을 실행하면 안내 메시지와 함께 차단됩니다.

### Admin 전용 또는 Admin 중심 명령

| 명령어 | 설명 |
| --- | --- |
| `/where` | 현재 채널의 컴퓨터, workspace, cwd, 세션 연결 상태를 보여줍니다. |
| `/status` | `/where` 정보와 함께 현재 agent model, effort, 설정 출처를 보여줍니다. |
| `/settings` | 이 main 채널이 관리하는 Codex 또는 Claude Code 기본 model/effort를 보여줍니다. |
| `/model model:<모델 또는 default>` | 이 컴퓨터의 해당 agent 기본 모델을 영구 저장합니다. `default`는 CLI 기본 모델을 사용합니다. |
| `/effort level:<단계>` | 해당 agent 기본 effort를 영구 저장합니다. Codex 최고값은 `xhigh`, Claude 최고값은 `max`입니다. |
| `/browse` | 현재 폴더의 파일 브라우저 UI를 엽니다. |
| `/shell command:<명령>` | 현재 cwd에서 shell 명령을 실행합니다. |
| `/diff` | 현재 cwd에서 `git diff --stat`을 실행합니다. |
| `/clear count:<숫자>` | 관리자 채널의 최근 메시지를 지정한 수만큼 삭제합니다. 최대 100개까지 삭제합니다. |
| `/clear all:true` | 관리자 채널의 가능한 최근 메시지 전체 삭제 확인 카드를 엽니다. 실제 삭제는 `clear all confirm`으로 확정합니다. |
| `/sync limit:<숫자>` | 활성 Codex 세션 선택 드롭다운을 엽니다. |
| `/sync-select limit:<숫자>` | `/sync`와 동일하게 선택 드롭다운을 엽니다. |
| `/sync-all limit:<숫자>` | 활성 세션을 선택 없이 즉시 동기화합니다. |
| `/sync-status` | 동기화된 카테고리, 채널, 보관 세션 상태를 보여줍니다. |
| `/sync-mode mode:on-chat 또는 realtime` | 동기화된 세션 채널의 transcript 반영 방식을 선택합니다. |
| `/sync-delete mode:preview/all/channels/session session_id:<id> confirm:<true/false>` | 동기화된 Discord 채널 삭제를 미리보기/확정합니다. 미리보기 카드에서 삭제할 채널 하나를 드롭다운으로 고를 수 있습니다. 로컬 Codex 세션 파일은 삭제하지 않습니다. |
| `/sync-archive session_id:<id> confirm:<true/false>` | 특정 Codex 세션을 bridge 보관 목록에 넣어 다음 sync에서 제외합니다. |
| `/schedule action:create mode:once/every/daily/weekly command:<명령> at:<시간> every:<주기> weekdays:<요일>` | 기존 채팅형 명령을 특정 시간/주기/요일에 반복 실행하도록 예약합니다. |
| `/schedule action:list` | 등록된 예약 명령을 보여줍니다. |
| `/schedule action:delete id:<id>` | 예약 명령을 삭제합니다. |
| `/chat-new location:general/current/path name:<이름> cwd:<경로> category:<true/false> prompt:<요청>` | 새 Codex 채팅 채널을 만듭니다. `general`은 일반 채팅, `current`는 현재 채널의 작업 폴더, `path`는 지정한 `cwd`에서 시작합니다. |
| `/reload mode:commands` | Discord slash command를 다시 등록합니다. |
| `/reload mode:restart confirm:true` | 봇 프로세스를 Discord에서 재시작 요청합니다. |
| `/codex-command command:<name> prompt:<args>` | 운영 단축 명령을 실행합니다. Admin에서는 `diff`, `mcp` 등 운영 명령만 사용하고 Codex 대화형 shortcut은 차단됩니다. |

`/model`의 `model` 옵션은 채널 종류를 보고 Codex 또는 Claude Code 추천 모델을 자동완성합니다. Codex 추천 목록은 해당 컴퓨터의 `codexHome/models_cache.json`에서 사용 시점에 읽고, Claude Code는 CLI의 안정적인 모델 별칭을 제안합니다. 목록에 없는 provider 또는 사용자 지정 모델명도 직접 입력할 수 있습니다.

### Session 전용 또는 Session 중심 명령

| 명령어 | 설명 |
| --- | --- |
| `/codex prompt:<요청>` | Codex에게 자연어 요청을 보냅니다. |
| `/review prompt:<관점>` | `codex exec review`로 현재 변경사항을 리뷰시킵니다. |
| `/fix-tests` | 테스트 실행, 실패 분석, 수정, 재검증을 요청합니다. |
| `/summarize target:<대상>` | 현재 채널 또는 지정 대상을 요약합니다. |
| `/howtouse [prompt]` | 현재 Codex 또는 Claude Code 세션에 Discord 첨부 송수신 형식과 agent별 사용자 질문 지원 범위를 안내합니다. `prompt`를 붙이면 안내와 함께 해당 요청을 같은 턴에 전달합니다. |
| `/compact prompt:<요청>` | 대화형 `/compact` passthrough가 아니라, 현재 작업 맥락을 압축 요약하도록 Codex에 요청합니다. |
| `/skill name:<skill> prompt:<요청>` | 지정한 skill 관점으로 Codex 요청을 실행합니다. |
| `/model model:<모델 또는 default>` | 현재 Codex 또는 Claude Code thread의 모델 override를 영구 저장합니다. `default`는 main 기본값을 다시 상속합니다. |
| `/effort level:low/medium/high/xhigh/max/default` | 현재 thread의 effort override를 저장합니다. Codex의 `max` 입력은 `xhigh`로 정규화됩니다. |
| `/settings` | 현재 thread에 실제 적용되는 model/effort와 `main default`, `thread override`, `CLI default` 출처를 보여줍니다. |
| `/archive` | 현재 세션 채널의 보관 확인 카드를 엽니다. 확정하려면 `archive confirm`을 사용합니다. |
| `/fork` | Codex 또는 Claude Code session thread에서 이름 입력 모달을 열고, 현재 agent session을 새 Discord thread로 fork합니다. |
| `/steer prompt:<지시>` | 일반 메시지와 동일하게 현재 실행 중인 Codex 또는 Claude Code turn에 새 지시를 즉시 추가하는 명시적 별칭입니다. |
| `/interrupt` | 현재 실행 중인 Codex 또는 Claude Code turn에 중단 요청을 보냅니다. |
| `/queue prompt:<요청>` | 현재 turn에 steering하지 않고, 작업이 끝난 뒤 실행할 다음 요청으로 FIFO 대기열에 추가합니다. prompt를 비우면 대기열 상태를 보여줍니다. |
| `/queue-clear` | 현재 실행은 유지하고 아직 시작하지 않은 대기 요청을 삭제합니다. |
| `/where` 또는 `/status` | 큐를 기다리지 않고 현재 채널의 컴퓨터, workspace, cwd, 세션, model/effort와 출처, agent 실행 상태를 보여줍니다. 실행 중이면 요청 요약, 시작 시각, 경과 시간, 마지막 활동 시각, 대기 요청 수도 표시합니다. |
| `/browse` | 현재 폴더의 파일 브라우저 UI를 엽니다. |
| `/shell command:<명령>` | 현재 cwd에서 shell 명령을 실행합니다. 일반 텍스트 shell 명령은 `!` 접두어를 사용합니다. |
| `/diff` | 현재 cwd에서 `git diff --stat`을 실행합니다. |
| `/codex-command command:<name> prompt:<args>` | `model`, `review`, `compact`, `mcp` 같은 session shortcut을 같은 라우터로 실행합니다. |
| `/schedule action:create mode:once/every/daily/weekly command:<명령> at:<시간> every:<주기> weekdays:<요일>` | 이 세션 채널에서 기존 채팅형 명령을 예약 실행합니다. |

Session thread의 `/model` 자동완성도 현재 agent 종류와 해당 컴퓨터의 모델 목록을 따릅니다. 자동완성은 추천 기능일 뿐이므로 직접 입력한 모델명은 기존과 동일하게 override로 저장됩니다.

`/fork`와 `/howtouse`는 앞에 `/`가 붙은 명령으로만 동작합니다. `fork는 잘 되는건가?`, `howtouse 내용을 바꿔줘`처럼 같은 단어가 들어간 일반 메시지는 명령으로 해석하지 않고 현재 agent에게 그대로 전달합니다.

### 채팅형 예약 명령

`/schedule`은 아래 채팅형 명령과 같은 라우터를 사용합니다. 예약 대상 `command:`에는 이미 지원되는 채팅형 명령을 넣습니다.

```text
schedule list
schedule every 10m command:shell pwd
schedule daily at 09:30 command:codex 오늘 계획 정리
schedule weekly mon,wed,fri at 09:30 command:shell pnpm test
schedule once at 2026-04-25 09:30 command:sync status
schedule delete <schedule-id>
```

```text
/schedule action:create mode:every every:10m command:shell pwd
/schedule action:create mode:daily at:09:30 command:codex 오늘 계획 정리
/schedule action:create mode:weekly weekdays:mon,wed,fri at:09:30 command:shell pnpm test
/schedule action:list
/schedule action:delete id:<schedule-id>
```

예약은 `.connect/state.json`에 저장되고 봇 재시작 후에도 유지됩니다. 봇은 기본 30초 주기로 만료된 예약을 확인합니다. `CONNECT_SCHEDULE_POLL_INTERVAL_MS`로 확인 주기를 조정할 수 있습니다.

## 세션 동기화

`sync`는 기본적으로 바로 생성하지 않고 선택 UI를 엽니다.

```text
sync
sync 10
sync select 25
/sync limit:25
```

위 명령은 최근 활성 Codex 세션 목록을 드롭다운으로 보여주고, 선택한 세션만 Discord 채널로 생성합니다.

전체 활성 세션을 즉시 동기화하려면 명시적으로 `all`을 사용합니다.

```text
sync all 25
/sync-all limit:25
```

동기화 대상은 Codex thread state에서 활성으로 확인된 앱 세션만입니다. 다음 항목은 제외됩니다.

- Codex에서 보관된 세션
- bridge에서 보관한 세션
- sub-agent 세션
- `codex exec` 또는 CLI 일회성 세션
- `session_index.jsonl`에는 있지만 thread state에서 확인되지 않는 만료/유실 세션

동기화 상태는 아래 명령으로 확인합니다.

```text
sync status
/sync-status
```

동기화된 세션 채널의 Codex transcript 반영 방식은 두 가지입니다.

```text
sync mode on-chat
sync mode realtime
/sync-mode mode:on-chat
/sync-mode mode:realtime
```

- `on-chat`: 실시간 폴링은 하지 않고, 동기화된 세션 채널에서 다시 채팅을 시작할 때 Codex 데스크탑의 최신 대화 내용을 먼저 반영합니다.
- `realtime`: 봇이 기본 약 5초 주기로 동기화된 세션을 확인해 Codex Desktop이나 IDE에서 생긴 새 대화 내용을 Discord 채널에 반영합니다.
- Desktop/IDE에서 보낸 사용자 메시지와 Codex가 외부에 공개한 commentary는 각각 별도의 새 Discord 메시지로 올라옵니다. 진행 메시지에는 operator role을 멘션하지 않습니다.
- `생각 중`, 명령 실행 상태, 파일 변경 상태 같은 내부 상태 이벤트는 보내지 않습니다. `final_answer`도 진행 피드에서는 제외하고, 기존 작업 완료 알림에서 답변과 operator role 멘션을 한 번만 보냅니다.
- Discord에서 직접 실행 중인 세션은 기존 스트리밍 메시지와 중복되지 않도록 transcript 기준점만 갱신합니다.
- `realtime`은 새 Discord 채널을 자동 생성하지 않습니다. 열려 있지 않은 Codex 세션을 Discord로 가져오려면 admin 채널에서 `sync` 또는 `/sync`를 명시적으로 실행합니다.
- 폴링 간격은 `CONNECT_TRANSCRIPT_SYNC_INTERVAL_MS`로 조정할 수 있습니다. 변화가 없거나 시스템 부하가 높으면 백그라운드 스캔은 자동으로 최대 `CONNECT_BACKGROUND_POLL_MAX_INTERVAL_MS`까지 늦춰집니다.
- `CONNECT_BACKGROUND_MAX_LOAD`는 CPU core 수로 나눈 1분 load average 기준입니다. 기본값은 `0.7`이고, `0`으로 설정하면 부하 기반 스킵을 끕니다.

처음 동기화된 채널은 과거 로그를 한꺼번에 쏟아내지 않도록 기준점만 잡고, 이후 새 transcript만 올립니다.

## 완료 알림과 세션 스레드

봇은 Codex native session log를 폴링해서 `작업 완료` 이벤트를 감지합니다. 알림 대상은 bridge 보관 목록에 들어 있지 않은 Codex 세션이며, 처음 켜졌을 때 이미 끝나 있던 작업은 과거 알림 폭주를 막기 위해 기준점만 잡고 넘어갑니다.

완료 알림은 가능한 경우 세션별 Discord 스레드로 전송됩니다. 스레드가 아직 없으면 Codex 대화방 이름을 Discord 스레드 이름 규칙에 맞게 정리해서 만들고, 설정된 operator role을 멘션해 스레드에서도 알림이 보이게 합니다. 스레드를 만들 수 없는 환경에서는 관리자 채널로 대신 보냅니다.

알림 본문에는 세션 이름, 작업 위치, 업데이트 시각, 세션 ID가 포함됩니다. Codex Desktop이나 IDE에서 시작한 작업처럼 Discord에 최종 답변이 아직 없던 작업은 완료 알림에 마지막 답변 preview를 함께 붙입니다. Discord에서 직접 보낸 Codex 요청은 이미 결과 메시지로 답변이 오기 때문에, 그 요청에 대응하는 완료 알림 한 번만 답변 preview를 생략해 같은 답변이 두 번 올라오지 않게 합니다. 같은 세션에서 이후 Desktop이나 IDE 작업이 완료되면 다시 답변 preview를 포함합니다.

같은 완료 이벤트는 `.connect/state.json`에 기록되어 중복 전송되지 않습니다. 봇은 알림을 보내기 전에 먼저 해당 완료 이벤트를 state에 예약 기록하므로, 짧은 폴링 간격이나 reload 직후에도 같은 완료 알림이 겹쳐 올라올 가능성을 줄입니다.

## Codex 진행 표시와 이미지

Codex 요청 중에는 raw 이벤트명 대신 읽기 쉬운 한국어 상태가 표시됩니다.

```text
42개 파일 · rg --files
진행: 파일 탐색 중

진행: 이미지 생성 중
진행: 컨텍스트 압축 중
진행: 답변 작성 중
```

Discord에서 직접 요청한 Codex 및 Claude Code의 최종 답변은 agent 종류와 요청 시작 위치에 관계없이 `작업 완료` 메타데이터와 `답변` embed가 있는 같은 카드 형식으로 전송됩니다. 한 메시지 제한을 넘으면 문단과 줄바꿈을 우선해 `답변 (계속)` 카드로 나눠 순서대로 전송합니다. 코드 블록은 각 분할 메시지 안에서 닫고 다음 메시지에서 다시 열며, 모든 답변 조각을 보낸 뒤에만 operator role이 포함된 완료 알림을 보냅니다.

### Discord에서 agent로 파일 보내기

Direct mode의 관리 채널이나 session thread에서 Discord 메시지에 이미지, 영상, 오디오 또는 일반 파일을 첨부하면 봇이 해당 컴퓨터의 `.connect/incoming-attachments/<message-id>/` 아래에 먼저 저장합니다. Codex/Claude Code에는 원래 파일명, MIME type, 크기, 로컬 절대경로가 prompt와 함께 전달되므로 agent가 로컬 도구로 파일을 직접 열 수 있습니다. 본문 없이 파일만 보내면 `첨부된 파일을 확인해줘.`라는 기본 요청으로 처리됩니다. main/admin 채널의 첨부 메시지는 기본적으로 Codex로 보내며, Claude Code로 보내려면 본문을 `claude <요청>`으로 시작합니다.

다운로드는 Discord CDN의 HTTPS 첨부 URL만 허용합니다. 기본 제한은 메시지당 10개, 파일당 100MiB, 메시지 전체 250MiB이며 Discord 서버 자체의 업로드 제한도 먼저 적용됩니다. 임시 파일은 기본 7일 동안 보관되고 다음 첨부 처리 시 만료 항목을 정리합니다. 다음 환경변수로 조정할 수 있습니다.

```bash
CONNECT_INCOMING_ATTACHMENT_ROOT=/absolute/path/to/incoming-attachments
CONNECT_INCOMING_ATTACHMENT_MAX_FILES=10
CONNECT_INCOMING_ATTACHMENT_MAX_BYTES=104857600
CONNECT_INCOMING_ATTACHMENT_TOTAL_MAX_BYTES=262144000
CONNECT_INCOMING_ATTACHMENT_TTL_MS=604800000
```

첨부 입력은 bot gateway와 worker가 같은 컴퓨터의 파일시스템을 보는 Direct mode에서 지원합니다. Hub mode처럼 gateway와 agent가 서로 다른 컴퓨터라면 gateway의 로컬 경로를 agent가 열 수 없으므로 현재 첨부 입력을 거부합니다. 파일 경로는 durable queue에 포함되므로 gateway만 재시작해도 대기 중 요청이 이어집니다.

Codex가 최종 답변에 `![이미지](/로컬/절대/경로.png)` 형태의 로컬 이미지 파일을 포함하면, 봇은 해당 파일을 Discord 메시지에 첨부합니다. `https://...png` 같은 원격 이미지 URL은 메시지 본문에 함께 표시되어 Discord에서 미리보기로 볼 수 있습니다.

이미지 외의 파일, 동영상, 오디오를 명시적으로 첨부하려면 Codex가 최종 답변에 아래 블록을 넣으면 됩니다. 봇은 이 제어 블록을 Discord 본문에서는 숨기고, 존재하는 로컬 파일만 첨부합니다.

````text
```codex-discord-send
{
  "message": "Discord 메시지에 같이 보여줄 문장",
  "files": [
    "/absolute/path/result.png",
    {"path": "/absolute/path/demo.mp4", "name": "demo.mp4"},
    {"path": "/absolute/path/audio.wav", "name": "audio.wav"}
  ]
}
```
````

`files`에는 절대경로 또는 `file://` URL을 넣습니다. 기본 업로드 안전 한도는 파일당 10MiB(Discord 표기 10MB)입니다. 파일 개수가 많으면 connector가 Discord의 메시지별 제한에 맞춰 파일 전용 메시지 여러 개로 자동 분할하며, 답변 본문에는 파일을 섞지 않습니다. 더 큰 파일은 여러 파일로 쪼개거나, 압축/리사이즈/인코딩 옵션 조정으로 용량을 낮춘 뒤 첨부해야 합니다. 세션 채널에서 `/howtouse`를 실행하면 채널 모드에 따라 이 형식이 현재 Codex 또는 Claude Code 세션에 직접 전달됩니다. `.mp3`, `.wav`, `.m4a` 같은 오디오 파일도 같은 방식으로 첨부됩니다.

최종 답변에는 `답변 복사` 버튼이 붙습니다. Discord 앱은 bot interaction에 운영체제 클립보드 쓰기 권한을 제공하지 않으므로, 4,000자 이하 답변은 원문이 채워진 선택 가능한 modal을 열고 더 긴 답변은 ephemeral `answer.txt`로 제공합니다. 복사용 원문은 `.connect/answer-copies`에 최대 500개, 기본 30일 동안 보관되며 `CONNECT_ANSWER_COPY_ROOT`로 위치를 변경할 수 있습니다.

동기화된 세션 채널에서 Discord로 보낸 요청은 항상 같은 Codex 세션에 `resume`되므로, Codex Desktop 쪽에서도 같은 세션 안에서 새 사용자 요청과 처리 과정이 이어집니다. Codex/Claude Code session thread에서는 `/fork`를 실행해 새 이름을 입력하면 기존 agent session을 분기하고, 같은 부모 채널 아래에 새 Discord thread를 만듭니다. fork 응답이 실패했거나 원본과 같은 session ID를 반환하면 연결하지 않고 임시 Discord thread를 정리하며, 이미 다른 Discord thread에 연결된 session ID의 중복 연결도 거부합니다. Codex fork는 `CODEX_DISCORD_CODEX_RUNNER=app-server` 모드에서 Codex app-server의 `thread/fork`를 사용합니다.

Codex 또는 Claude Code 작업이 실행 중일 때 같은 Discord thread에 보내는 일반 메시지는 현재 turn에 즉시 steering됩니다. Codex는 app-server turn control을, Claude Code는 같은 CLI 프로세스의 `stream-json` stdin을 사용합니다. 현재 작업을 건드리지 않고 다음 turn으로 남기려면 `/queue prompt:<요청>`을 사용합니다. turn 등록 직후의 짧은 경쟁 상태는 자동으로 재시도합니다. Codex에서 활성 요청이 남아 있는데도 steering이 실패하거나 지원되지 않으면 일반 메시지를 FIFO로 바꾸지 않고 Discord에 실패를 표시합니다. Claude Code가 응답을 끝내며 stdin을 닫는 경계에서 steering을 받지 못하면 메시지를 잃지 않도록 다음 FIFO turn으로 보존합니다. `/steer`는 명시적 steering 별칭으로 계속 지원하고, prompt 없는 `/queue`는 현재 실행과 대기 요청을 보여줍니다. 후속 agent 요청이 남아 있으면 중간 turn의 완료 멘션은 생략하고 큐가 모두 끝났을 때 한 번만 알립니다. 실패와 권한 요청은 즉시 멘션합니다. Direct mode의 agent 요청과 FIFO 대기열은 `.connect/discord-queue`와 `.connect/worker`에 기록되므로 bot 재시작 후에도 유지됩니다.

`/status`와 `where`도 대기열을 우회하므로 긴 작업 도중 즉시 조회할 수 있습니다. `Agent state`가 `running`이면 Discord에서 시작한 요청이 아직 반환되지 않은 상태이고, `waiting-for-approval`이면 권한 선택, `waiting-for-user-input`이면 Codex 질문에 대한 답변을 기다리는 상태입니다. `Last activity`가 오래되었다면 모델 응답이나 외부 명령을 기다리는 중인지 진행 메시지와 시스템 상태를 함께 확인하세요.

Codex와 Claude Code thread에서는 agent가 직접 작성한 중간 설명만 별도 메시지로 전송하되 role을 mention하지 않습니다. 명령 실행, 파일 수정, 검색, `item.started`, `생각 중`, `답변 작성 중` 같은 상태 이벤트는 진행 피드에 게시하지 않습니다. 마지막 agent 메시지는 최종 답변으로 간주해 중간 피드에서 제외하며, 동일 문구를 제거하고 작업당 최대 40개까지 보냅니다. 작업이 끝나면 처음의 진행 카드는 완료 상태로 닫고, 최종 답변은 마지막 진행 메시지 아래에 새 메시지로 게시한 뒤 operator role을 mention합니다. 응답의 `finalMessage`가 비어 있으면 마지막 공개 agent 메시지를 최종 답변으로 복구합니다. 새 요청 직전 transcript 동기화는 기준점만 갱신하고 이전 대화를 다시 게시하지 않습니다.

## Codex 권한 요청 처리

Direct mode는 별도 설정이 없으면 Codex app-server runner를 사용합니다. 호환성 때문에 예전 `codex exec` 방식이 꼭 필요할 때만 `CODEX_DISCORD_CODEX_RUNNER=exec`를 명시하세요. app-server runner는 Discord에서 실행하는 작업을 로컬/서버 자동화 용도로 쓰기 위해 기본적으로 아래 권한 설정으로 실행됩니다.

```text
approval=never, reviewer=user, sandbox=danger-full-access, network=enabled
```

권한은 환경변수로 조정할 수 있습니다.

```bash
CODEX_DISCORD_CODEX_APPROVAL_POLICY=on-request
CODEX_DISCORD_CODEX_SANDBOX=workspace-write
```

`CODEX_DISCORD_CODEX_SANDBOX` 값은 `read-only`, `workspace-write`, `danger-full-access` 중 하나입니다. `danger-full-access`는 Codex의 OS sandbox를 풀기 때문에 신뢰하는 private Discord 서버와 신뢰하는 머신에서만 사용하세요. 더 좁은 권한이 필요하면 위 환경변수로 `workspace-write`나 `read-only`로 낮출 수 있습니다. `codex exec` runner에서는 `CODEX_DISCORD_CODEX_BYPASS_APPROVALS_AND_SANDBOX=1`도 지원하지만, app-server runner를 쓰는 일반 Mac 설정에서는 `danger-full-access`를 사용합니다.

작업 중 Codex가 sandbox 밖 파일 변경, 명령 실행, 파일 패치, 추가 권한을 요청하면 봇이 같은 Discord 채널에 권한 요청 메시지를 보냅니다. operator role이 있는 사용자는 버튼으로 아래 선택을 할 수 있습니다.

- `허용`: 이번 요청만 허용합니다.
- `세션 동안 허용`: 같은 Codex 세션에서 같은 종류의 요청을 계속 허용합니다.
- `거절`: 요청을 거절하고 Codex에 거절 결과를 전달합니다.
- `취소`: 현재 권한 요청을 취소합니다.

권한 요청은 해당 Codex 작업이 진행 중인 채널에서만 유효합니다. 오래된 버튼이나 다른 채널에서 온 응답은 무시되며, 찾을 수 없는 요청이라는 안내를 보냅니다.

## Codex 사용자 질문 처리

Codex가 작업 중 `request_user_input` 도구를 호출하면 봇은 같은 Discord 스레드에 operator role을 멘션한 질문을 보냅니다. 선택지가 있으면 `1`, `2` 같은 번호나 선택지 이름으로 답할 수 있고, 직접 문장을 보내도 됩니다. 이 답변은 새 작업, FIFO 큐, steering으로 처리되지 않고 대기 중인 같은 app-server turn의 도구 응답으로 즉시 전달됩니다. 질문이 여러 개면 한 번에 하나씩 순서대로 표시합니다.

미디어를 함께 검수하려면 agent가 최종 답변 또는 `request_user_input.question` 안에 `codex-discord-survey` JSON block을 넣습니다. 최종 block에는 `question`, `files`, `options`, `multiple`을 넣고, 중간 질문 block에는 주로 `files`와 `multiple`만 넣은 뒤 선택지는 `request_user_input.options`를 사용합니다. 모든 설문에는 `기타...` 버튼이 함께 표시되며 사용자는 모달에서 선택지에 없는 자유 답변을 제출할 수 있습니다. 최종 선택과 자유 답변은 source agent를 보존한 명시적 queue prompt로 변환되므로 활성 turn에 steering되지 않습니다. 중간 선택과 자유 답변은 token과 channel을 검증한 뒤 현재 user-input request에만 전달됩니다. 질문 메시지 자체가 Operator role을 mention하며, 최종 설문이 있으면 별도의 완료 mention은 중복 전송하지 않습니다. 최대 설문 5개, 설문당 선택지 25개이며 첨부에는 기존 10MiB 안전 한도와 메시지별 파일 분할 규칙을 적용합니다.

질문을 기다리는 동안 `/status`, `/interrupt`, `/queue prompt:<요청>` 같은 제어 명령은 질문 답변으로 소비되지 않습니다. `/interrupt`는 대기 중인 질문도 해제하고 현재 turn을 중단합니다. `autoResolutionMs`가 있는 질문은 제한 시간이 지나면 첫 번째 권장 선택지로 자동 진행합니다. 비밀 입력 질문도 Discord에는 일반 메시지로 보이므로 토큰과 비밀번호는 보내지 마세요. 이 기능은 Codex app-server 전용이며 현재 Claude Code headless 경로에는 적용되지 않습니다.

## 보관과 삭제

로컬 Codex 세션 파일을 삭제하지 않고 Discord mapping에서만 제외하려면 보관을 사용합니다.

```text
archive confirm
sync archive <session-id> confirm
/sync-archive session_id:<session-id> confirm:true
```

동기화로 생성된 Discord 채널을 삭제하려면 먼저 미리보기를 확인합니다.

```text
sync delete preview
sync delete session <session-id>
sync delete session <session-id> confirm
sync delete channels confirm
sync delete all confirm
/sync-delete mode:preview
/sync-delete mode:session session_id:<session-id> confirm:true
```

`sync delete session <session-id> confirm`은 해당 세션의 Discord 채널과 mapping만 삭제하고, 나중에 다시 `sync`하면 다시 가져올 수 있습니다. `sync archive <session-id> confirm`은 세션을 보관 목록에 넣어 다음 sync에서도 제외합니다. `sync delete channels confirm`은 텍스트 채널만 삭제합니다. `sync delete all confirm`은 텍스트 채널과 카테고리를 삭제하고 `.connect/state.json`의 동기화 상태를 정리합니다. 로컬 Codex 세션 파일은 삭제하지 않습니다.

## 파일 브라우저와 작업 버튼

`ls` 또는 `/browse` 결과에는 Discord UI가 붙습니다.

- `상위 폴더`: 현재 cwd를 상위 폴더로 이동합니다.
- `새로고침`: 현재 폴더 목록을 다시 불러옵니다.
- `여기서 새 채팅`: 현재 브라우저 위치에서 새 Codex 채팅 모달을 엽니다.
- `하위 항목으로 이동`: 드롭다운에서 폴더를 선택해 이동합니다.
- `파일 보기`: 드롭다운에서 파일을 선택해 미리봅니다.
- `Codex에게 요청`: session 채널에서만 표시되며, 모달을 열어 현재 컨텍스트로 Codex에게 요청합니다.

Git과 테스트 결과에도 작업 버튼이 붙습니다.

- Admin 채널의 `git status --short`: Diff 보기, 테스트 실행 버튼 제공
- Session 채널의 `git status --short`: Diff 보기, Codex 리뷰, 테스트 실행 버튼 제공
- Admin 채널의 `pnpm test`: 테스트 다시 실행 버튼 제공
- Session 채널의 `pnpm test`: 테스트 다시 실행, 실패 시 Codex에게 수정 요청 버튼 제공
- `유지보수` 패널: Git 상태, Diff 보기, 충돌 점검, 테스트 실행, 봇 재시작 또는 Codex 리뷰/수정 버튼을 한곳에 모읍니다.

## Discord에서 봇 자체 유지보수

관리자 채널에서 `help`를 누른 뒤 `유지보수` 패널을 엽니다.

```text
유지보수 → 봇 개발 채팅 → Codex에게 수정 요청 → 타입체크 → 테스트 실행 → 명령어 재등록 또는 봇 재시작
```

- `봇 개발 채팅`: 현재 workspace에서 이 봇 유지보수용 Codex 세션 채널을 만듭니다.
- `타입체크`: `pnpm typecheck`를 실행합니다.
- `테스트 실행`: `pnpm test`를 실행합니다.
- `명령어 재등록`: 코드 변경 없이 slash command만 다시 등록합니다.
- `봇 재시작`: 새 작업 유입을 막고 실행 중 작업과 대기열이 끝난 뒤 봇 프로세스를 재시작합니다. `pnpm connect start`로 실행 중일 때 사용하세요.

## 봇 업데이트

Discord에서 봇 명령어를 다시 등록할 수 있습니다.

```text
reload
/reload mode:commands
```

새 코드까지 반영하려면 봇 재시작을 요청합니다.

```text
reload restart confirm
/reload mode:restart confirm:true
```

기본 재시작은 다른 채널의 활성 작업과 대기열이 모두 끝날 때까지 자동으로 보류되며, 보류 중에는 권한 응답과 `/status`, `/queue`, `/interrupt` 같은 제어 명령만 받습니다. 즉시 bot 코드를 다시 읽어야 한다면 아래 강제 명령을 사용합니다. 분리된 Direct worker는 어느 방식이든 종료되지 않으므로 실행 중 작업은 계속되고, 새 bot이 재연결합니다.

```text
reload restart force confirm
/reload mode:restart force:true confirm:true
```

bot 전용 systemd/LaunchAgent만 재시작하는 것은 실행 worker에 영향을 주지 않습니다. worker service는 `SIGTERM`을 받으면 새 job을 시작하지 않고 활성 job이 끝날 때까지 drain한 뒤 종료합니다. `SIGKILL`, 서버 재부팅, worker service의 강제 종료는 실행 중인 Codex/Claude와 하위 프로세스를 중단합니다.

자동 재시작은 `pnpm connect start --direct` 또는 `pnpm connect start --hub`로 실행 중일 때 동작합니다. 운영 환경에서는 `--component bot`과 `--component worker`를 별도 서비스로 실행하는 구성을 권장합니다. `pnpm dev:bot`로 직접 실행 중이면 프로세스가 종료되므로 터미널에서 다시 시작해야 합니다.

## 안전 정책

- 허용된 Discord role을 가진 사용자만 명령을 실행할 수 있습니다.
- 각 Discord 채널은 독립적인 cwd를 가집니다.
- `cd`는 해당 채널의 cwd만 변경합니다.
- Local Agent는 OS sandbox가 아니므로 명령은 로컬 사용자 권한으로 실행됩니다.
- Direct mode가 기본 권장 구성입니다. Hub mode는 다중 컴퓨터 실험 기능이며 네트워크 공격면이 더 넓습니다.
- 절대 경로, 상위 경로 이동, shell escape, 위험 명령은 확인이 필요합니다.
- 보관과 Discord 채널 삭제는 로컬 Codex 세션 파일을 삭제하지 않습니다.
- `.env`, `.connect/` 전체, 로그, 로컬 DB, Codex 세션 파일은 커밋하거나 npm 패키지에 포함하지 마세요.
- Discord bot token이 노출되면 Discord Developer Portal에서 즉시 token을 재발급하고 봇을 재시작하세요.
- 공개 Discord 서버나 신뢰하지 않는 role에는 연결하지 마세요. 이 도구는 private server와 제한된 운영자 role을 전제로 합니다.
- 같은 bot token을 여러 머신에서 실행할 때는 머신별 Discord 채널 ID를 겹치지 않게 설정하세요. 같은 채널을 두 인스턴스가 맡으면 중복 실행이 생길 수 있습니다.

## 기여와 라이선스

기여 가이드는 [CONTRIBUTING.md](../CONTRIBUTING.md)를 참고하세요. 이 프로젝트는 [MIT License](../LICENSE)로 배포됩니다. 기여를 제출하면 해당 기여도 MIT License로 제공하는 데 동의한 것으로 간주합니다.

## npm 공개 전 점검

배포 전에 아래 명령으로 테스트, 타입체크, 패키지 포함 파일을 확인합니다.

```bash
pnpm test
pnpm typecheck
npm pack --dry-run
```

`npm pack --dry-run` 출력에 아래 항목이 포함되지 않아야 합니다.

- `.env`
- `.connect/`
- `*.sqlite`, `*.log`
- Discord token 또는 guild/channel/role secret이 들어 있는 파일
- Codex transcript/session 원본 파일

취약점 제보와 운영 보안 모델은 [SECURITY.md](../SECURITY.md)를 참고하세요.

## 프로젝트 구성

```text
apps/
  connect-cli/      설치, 설정, 실행 CLI
  control-api/      hub mode용 Control API
  discord-bot/      Discord bot, slash command, 버튼/드롭다운 처리
  local-agent/      hub mode agent와 direct mode durable worker
packages/
  codex-adapter/    Codex session index/thread state/transcript parser
  core/             command policy, domain model
docs/
  operator-guide.md 운영자용 세부 가이드
```

상태 파일은 주로 아래 위치에 저장됩니다.

- `.connect/config.json`: 연결 설정
- `.connect/state.json`: direct mode 동기화 상태
- `.connect/discord-queue`: Discord agent 요청과 FIFO 복구 정보
- `.connect/worker`: 실행 요청, 진행 이벤트, 승인, 결과를 보관하는 worker spool
- `.env`: 실행 환경 변수
- `$HOME/.codex`: Codex native 세션, thread state, transcript

## 개발 명령

소스에서 개발할 때는 pnpm workspace 명령을 사용합니다.

```bash
pnpm install
pnpm connect install --direct
pnpm connect start --direct
```

운영 서비스는 bot과 worker를 따로 실행할 수 있습니다.

```bash
pnpm connect start --direct --component worker
pnpm connect start --direct --component bot
```

```bash
pnpm test
pnpm typecheck
pnpm test:watch
```

개별 프로세스 실행:

```bash
pnpm dev:control
pnpm dev:agent
pnpm dev:bot
```

Prisma를 사용하는 hub mode DB 작업:

```bash
DATABASE_URL="file:./dev.sqlite" pnpm prisma db push
pnpm prisma:generate
pnpm prisma:migrate
```

## 문제 해결

### Slash command가 Discord에 보이지 않음

관리자 채널에서 명령어를 다시 등록합니다.

```text
reload
```

그래도 보이지 않으면 봇을 재시작합니다.

```text
reload restart confirm
```

### `sync`에 원하지 않는 세션이 보임

`sync`는 thread state에서 활성으로 확인된 앱 세션만 가져옵니다. 이미 Discord에 만들어진 오래된 채널은 아래 순서로 정리할 수 있습니다.

```text
sync delete preview
sync delete session <session-id> confirm
sync delete channels confirm
sync
```

### 현재 채널이 어디에 연결됐는지 모르겠음

```text
where
/where
```

### 작업 중인 봇 버전이 최신인지 모르겠음

```text
reload restart confirm
```

이 명령은 실행 중 작업이 있으면 완료될 때까지 기다립니다. 즉시 중단하고 재시작하려면 `reload restart force confirm`을 사용합니다.

## 참고 문서

- [User README](../README.md)
- [Operator Guide](operator-guide.md)
- [Mac Direct Mode Setup](mac-direct-setup.md)
- [Ubuntu Server Direct Mode Setup](ubuntu-server-direct-setup.ko.md)
