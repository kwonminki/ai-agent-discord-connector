# AI Agent Discord Connector

[![Version](https://img.shields.io/github/v/tag/kwonminki/ai-agent-discord-connector?sort=semver&label=version)](https://github.com/kwonminki/ai-agent-discord-connector/tags)
[![Windows compatibility](https://github.com/kwonminki/ai-agent-discord-connector/actions/workflows/windows-compatibility.yml/badge.svg)](https://github.com/kwonminki/ai-agent-discord-connector/actions/workflows/windows-compatibility.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%5E20.19%20%7C%7C%20%3E%3D22.12-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Ubuntu-555555)](#여러-컴퓨터-사용)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

한국어 | [English](README.en.md)

Mac, Windows, Ubuntu 서버에서 실행되는 **Codex와 Claude Code 같은 AI agent를 Discord 스레드로 사용하고, 서로 대화시킬 수 있는 개인용 브리지**입니다.

## v2.0 Release

> ### NEW · 대화로 만드는 Harness
> **파일 포맷을 몰라도 agent와 문답만 하면 반복 가능한 workflow를 만들고, 별도 실행 스레드에서 Codex와 Claude Code로 재사용할 수 있습니다.**
>
> `/harness create`에서 목표만 입력하면 현재 작업 세션을 이어가거나 빈 세션에서 전용 Builder를 열 수 있습니다. Builder는 discovery → 상세 설계 → 전체 설계 검토 → 사용자 확인 순서로 대화하며 목표, 실제 사용 예시, 입력, 단계와 분기, 산출물, 성공 기준, 권한·금지사항, 실패 처리, 참고자료와 필요한 역할을 구조화합니다. 검토한 설계를 사용자가 명시적으로 승인한 뒤 `/harness publish-run`으로 검증된 불변 버전을 발행하고, Builder와 분리된 실행 세션을 만듭니다.
>
> 발행본은 digest와 exact version으로 고정됩니다. Worker는 매 실행 전에 경로, 파일 목록, symlink, manifest와 digest를 다시 검증합니다. Codex에는 공식 app-server skill item으로, Claude Code에는 격리된 로컬 plugin으로 주입하며, 임의 hook·MCP·background agent·실행 스크립트는 Builder 출력에서 허용하지 않습니다. 기존 `/fork`도 Builder 상태 또는 실행 중인 exact snapshot을 별도 세션으로 안전하게 이어받습니다.

## v1.5 Release

> ### NEW · Agent-aware 컨텍스트 제어
> **Discord의 `/compact`가 현재 스레드의 agent를 구분해 올바른 방식으로 컨텍스트를 정리합니다.**
>
> Claude Code 스레드에서는 상주 세션의 네이티브 `/compact`를 실행하고, Codex 스레드에서는 현재 작업 맥락을 압축 요약합니다. 추가 지시도 함께 전달할 수 있으며, agent가 이미 작업 중이면 현재 turn을 방해하지 않고 다음 요청으로 안전하게 대기합니다. 명령 설명과 안내 문구는 한국어, 영어, 중국어, 일본어에서 동일하게 제공됩니다.
>
> **장기 Codex 작업의 상태도 더 정확해졌습니다.** Goal이 아직 진행 중인 turn은 Operator 멘션과 함께 **중간 답변**으로 표시하고, 실제 goal이 완료된 마지막 turn만 **작업 완료**로 알립니다. 자동 연속 turn으로 활성 turn ID가 바뀌어도 Discord steering이 최신 turn을 찾아 한 번 안전하게 재시도합니다.

## v1.4 Release

> ### v1.4.2 패치 · 장기 Codex 작업에서도 안정적인 steering
> **Codex goal이 자동 연속 turn으로 넘어가도 Discord의 후속 지시가 현재 실행 중인 turn을 다시 찾아 전달됩니다.**
>
> 이전에는 장기 goal이 다음 turn으로 자동 진행하면 Discord가 기억한 turn ID와 실제 활성 turn ID가 달라져 steering이 간헐적으로 실패했습니다. 이제 connector가 이 불일치를 감지하고 같은 thread의 최신 `inProgress` turn을 조회한 뒤 한 번 안전하게 재시도합니다. 일반 작업과 Claude Code의 stdin 기반 steering 동작은 그대로 유지됩니다.
>
> Goal이 아직 `active`, `paused`, `blocked`, `usageLimited`, `budgetLimited` 상태인 turn의 답변은 Discord에 **중간 답변**으로 표시하고 Operator를 멘션합니다. Goal 상태가 실제 `complete`가 된 마지막 turn은 **작업 완료**로 구분해 다시 알립니다.

> ### NEW · 상주 Agent 세션 — 예약과 백그라운드 작업이 실제로 돌아갑니다
> **Claude Code 세션이 메시지 사이에도 살아 있어, 채팅이 끝난 뒤에 발화한 예약(cron)·백그라운드 작업 결과가 Discord로 도착합니다.**
>
> 기존에는 메시지마다 agent 프로세스를 새로 띄워서 세션 안에 걸어둔 예약과 백그라운드 작업이 턴이 끝나는 순간 사라졌습니다. 이제 스레드마다 Claude Code 프로세스 하나가 idle로 유지되고, 조용한 사이에 나온 결과는 **Claude Code 세션 알림** 메시지로 해당 스레드에 게시됩니다. "30초 뒤에 알려줘" 같은 요청이 그대로 동작합니다. Codex도 app-server 하나를 상주시켜 메시지마다 서버를 재기동하던 낭비를 없앴습니다.
>
> 함께 추가: Claude thinking(생각)과 중간 진행 텍스트를 생략·절단 없이 분할 전송, `/chat-new location:browse` 폴더 탐색 UI, `/chat-resume`로 지운 스레드의 세션 복구, `/howtouse prompt:` 결합 전달, 메인 채널은 스레드 안내 전용으로 정리(채널 이름 변경 같은 Discord 시스템 메시지도 agent로 새지 않음), 대기열 작업마다 완료 멘션. v1.3의 원클릭 서버 업데이트와 [Agent Relay](docs/agent-relay.ko.md)도 그대로 포함됩니다.

> **v1.4.1 패치 · 컨텍스트 자동 압축:** 대화가 길어져 컨텍스트 사용량이 창의 60%(설정 가능)를 넘으면 자동으로 압축합니다. Claude Code는 상주 세션이 스스로 `/compact`를 실행하고 스레드에 🧹 알림을 남기며, Codex는 앱서버의 토큰 사용량 알림을 감시해 네이티브 압축(`thread/compact/start`)을 백그라운드로 실행합니다. 대화는 그대로 이어지고, 세션당 5분에 1회로 제한됩니다. `CODEX_DISCORD_{CLAUDE,CODEX}_AUTO_COMPACT_PCT`로 조절하거나 0으로 끌 수 있습니다.

> **v1.3 요약:** annotated tag를 push하면 release 채널 공지의 **등록 서버 업데이트** 버튼으로 연결된 컴퓨터들을 원클릭 업데이트할 수 있습니다. 사용자 스레드는 건드리지 않고 실행 중인 Worker는 graceful drain으로 보존합니다.

Discord에서 평소처럼 메시지를 보내면 agent가 연결된 컴퓨터에서 작업하고, 중요한 진행 상황과 최종 답변을 Discord로 돌려줍니다. 이미지, 영상, 오디오, 일반 파일도 양방향으로 주고받을 수 있습니다.

Codex만, Claude Code만, 또는 둘 다 연결할 수 있습니다. Connector가 어느 하나를 고정된 메인 agent로 가정하지 않으며, 둘 다 사용할 때는 메시지를 보낸 부모 채널에 따라 해당 agent로 연결됩니다.

> 이 봇은 연결된 컴퓨터에서 파일을 수정하고 명령을 실행할 수 있습니다. 신뢰하는 개인 Discord 서버와 본인이 관리하는 컴퓨터에서만 사용하세요.

## 시작하기

설치 절차를 직접 따라갈 필요가 없습니다. 아래 저장소 주소와 요청을 Codex 또는 Claude Code 같은 AI 에이전트에게 보내세요.

```text
https://github.com/kwonminki/ai-agent-discord-connector

이 저장소의 AI Agent Guide를 먼저 읽고 내 컴퓨터에 설치하고 설정해줘.
필요한 계정 작업만 한 단계씩 나에게 요청하고, 나머지는 직접 구성하고 검증해줘.
```

에이전트는 대화 언어와 운영체제를 알아서 확인하고, Codex와 Claude Code 중 무엇을 연결할지 물은 뒤 선택한 agent에 필요한 Discord 채널과 로컬 서비스를 구성합니다. 첫 컴퓨터가 준비되면 추가로 연결할 Mac, Windows 또는 Ubuntu 서버와 Agent Relay 대화 기능이 필요한지도 물어봅니다.

### 현재 배포 방식

현재 배포 방식은 신뢰하는 개인 환경에 직접 설치하는 self-hosted 방식입니다. Discord Gateway와 선택적인 Coordinator를 실행하는 쪽에는 각 bot token이 필요합니다. 사용자가 private Discord 서버를 만들고 bot application을 서버에 초대하면, 설치 에이전트가 역할, 채널, 권한, slash command, 로컬 worker와 서비스를 나머지 순서대로 구성할 수 있습니다.

프로젝트 운영자가 두 bot을 중앙에서 호스팅하고 다른 사용자가 초대만 해서 쓰는 방식에서는 최종 사용자가 bot token을 알 필요가 없습니다. 다만 그 방식에 필요한 multi-guild tenant 격리와 일회용 Local Agent pairing은 현재 v1의 완성된 배포 경로가 아닙니다. 현재 Control API와 Agent WebSocket을 인증 없이 공용 인터넷에 노출하지 마세요.

## 지원 언어

Connector와 Agent Relay Coordinator UI는 다음 언어를 지원합니다.

- 한국어
- 영어
- 중국어(간체)
- 일본어

설치 에이전트가 현재 대화 언어를 보고 Connector와 Coordinator를 같은 언어로 자동 설정합니다. 버튼, 모달, 상태 문구, slash command 설명과 `/howtouse`가 선택된 언어로 표시되며, 사용자 메시지와 agent 답변 원문은 임의로 번역하지 않습니다.

## Discord에서 사용하기

### 새 채팅

Codex 또는 Claude Code 부모 채널에서 `/chat-new`를 실행하면 새 Discord 스레드와 agent 세션이 만들어집니다.

둘 다 활성화한 경우 Codex 부모 채널에서 만든 스레드는 Codex로, Claude Code 부모 채널에서 만든 스레드는 Claude Code로 이어집니다. 별도의 전역 메인 agent는 없습니다.

```text
/chat-new name:로그인 버그 수정
```

만들어진 스레드에서는 자연어로 요청하면 됩니다.

```text
현재 코드 구조를 확인하고 로그인 오류를 고쳐줘.
테스트까지 실행한 뒤 결과를 알려줘.
이 영상에서 문제가 생기는 구간을 찾아줘.
```

### 진행 중 지시와 대기열

Codex가 작업 중일 때 같은 스레드에 보내는 일반 메시지는 현재 작업에 즉시 반영됩니다. 현재 작업이 끝난 다음 별도 작업으로 실행하려면 `/queue prompt:`를 사용하세요.

```text
/queue prompt:현재 수정이 끝나면 전체 테스트도 실행해줘
```

Codex 또는 Claude Code가 작업 중일 때 같은 스레드에 보낸 일반 메시지는 현재 turn에 즉시 steering됩니다. 현재 작업을 건드리지 않고 다음 turn으로 남기려면 `/queue prompt:<요청>`을 사용하세요.

### 세션 분기

기존 대화 맥락을 복제해 다른 방향으로 작업하려면 세션 스레드에서 `/fork`를 사용합니다. 원본과 fork 스레드는 서로 다른 agent 세션으로 이어집니다.

### Harness 만들기와 실행

Codex 또는 Claude Code 스레드에서 다음처럼 시작합니다.

```text
/harness create goal:이 프로젝트의 PR을 매번 같은 기준으로 리뷰하는 하네스를 만들고 싶어 source:현재 세션 이어서 (추천)
```

`source:current`는 지금까지의 대화 문맥을 복제하고, `source:fresh`는 빈 세션에서 시작합니다. 생성된 **Harness Builder** 스레드에서는 내부 파일 구조를 설명할 필요 없이 질문에 자연어로 답하면 됩니다. Builder는 읽기 전용으로 동작하면서 실제 사용 예시, 필요한 입력과 문맥, 세부 workflow와 분기, 산출물·성공 기준, 권한과 금지사항, 참고자료·역할, 실패 처리, 검증 사례를 차례로 구체화합니다.

Builder 스레드는 생성 즉시 링크가 표시되고, agent session 연결과 첫 질문 준비 상태가 같은 메시지에 갱신됩니다. 봇은 4단계 진행 방식과 답하는 법을 안내하고, 매 문답 뒤에는 현재 단계·응답 횟수·채워진 영역 수·다음 행동을 짧게 표시합니다. `추천해서 계속`, `이 설계대로 만들기`, `발행하고 실행`, `발행만`, `상태 보기` 버튼이 나타나므로 꼭 필요한 답만 직접 입력하면 됩니다. Builder가 숨김 JSON 형식을 잘못 출력하면 봇이 같은 agent 세션에 최대 3회 자동 수정을 요청하며, 예약된 내부 JSON 블록은 연결 상태가 바뀌어도 Discord 답변에 노출하지 않습니다. Builder는 최소 3회의 응답으로 설계를 탐색한 뒤 완성된 9개 영역을 체크리스트로 보여주고 확인을 요청합니다. 사용자가 다음 답변에서 그 설계를 승인해야만 후보를 생성합니다. 봇은 이 단계와 확인된 설계 digest를 별도로 저장하므로 첫 턴 후보, 누락된 설계, 확인 후 몰래 바뀐 설계는 거부합니다. `/harness status`로도 같은 상태를 확인할 수 있습니다.

```text
/harness publish-run first_request:현재 변경사항을 리뷰해줘
```

이 명령은 exact version과 digest로 불변 발행한 뒤 별도 실행 스레드를 만듭니다. 이후 그 스레드의 모든 요청에는 같은 발행본이 다시 주입됩니다. `/harness list`, `/harness status`, `/harness run`으로 발행본을 확인하거나 목록에서 골라 재사용할 수 있습니다. `/harness-help`는 agent 세션이 연결되지 않은 채널에서도 전체 사용법을 바로 보여줍니다. Builder 스레드와 실행 스레드에서 `/fork`하면 각각 설계 상태와 exact 실행 버전을 유지한 별도 agent 세션이 만들어집니다.

### 자주 쓰는 명령

| 명령 | 용도 |
| --- | --- |
| `/chat-new` | 새 Discord 스레드와 agent 세션 만들기. `location:browse`로 폴더를 눌러가며 선택 |
| `/status` | 실행 상태, 마지막 활동, 대기열과 모델 설정 확인 |
| `/settings` | 현재 적용되는 모델과 effort 확인 |
| `/model` | 채널별 추천 목록에서 부모 기본값 또는 현재 스레드 모델 변경. 직접 입력도 지원 |
| `/effort` | 부모 채널 기본값 또는 현재 스레드 effort 변경 |
| `/steer` | 실행 중인 Codex 또는 Claude Code 작업에 명시적으로 지시 추가 |
| `/queue` | 다음 turn 예약 또는 대기열 상태 확인 |
| `/queue-clear` | 아직 시작하지 않은 요청 삭제 |
| `/interrupt` | 현재 Codex 또는 Claude Code turn 중단 |
| `/fork` | 현재 세션 맥락을 복제해 새 스레드 만들기 |
| `/harness` | 선택형 메뉴로 Builder 생성, 검증·발행, exact version 실행과 상태 확인 |
| `/harness-help` | agent 세션 연결 없이 Harness 사용법 표시 |
| `/chat-resume` | 지운 스레드의 Claude Code 세션을 골라 스레드로 다시 열기 |
| `/howtouse` | 현재 agent에게 Discord 파일·설문 전송법 알려주기. `prompt:`로 요청을 함께 전달 |
| `/where` | 현재 컴퓨터, 작업 폴더와 session ID 확인 |
| `/agent-chat` | 현재 스레드와 다른 agent 스레드 사이의 자동 대화 시작 |
| `/agent-chat-status` | Agent Relay 왕복, turn, 상태 확인 |
| `/agent-chat-stop` | 현재 Agent Relay 대화 중지 |

별도의 Coordinator Bot을 활성화한 서버에서는 `/agent-chat`으로 현재 스레드와 다른 agent 스레드를 연결할 수 있습니다. 기본 최대 20왕복이며 A와 B가 각각 한 번 답하면 1왕복입니다. 두 agent의 최종 공개 답변과 Discord 첨부파일을 번갈아 전달하고, `extend` 요청이 오면 Operator가 완료 알림에서 왕복 1회를 추가하거나 연장을 거절하고 대화를 종료할 수 있습니다. 양쪽이 종료에 동의하거나 설정한 왕복·시간 제한에 도달하면 Operator 역할을 한 번 멘션합니다. 대화 중 현재 실행 중인 Codex 또는 Claude Code thread에 일반 메시지를 보내면 현재 turn에 steering되고, 대기 thread에서는 활성 thread를 안내합니다. `/agent-chat-stop`은 relay를 끝내고 현재 실행 중인 Codex 또는 Claude Code turn도 중단합니다.

### 원클릭 서버 업데이트

Coordinator와 GitHub release 공지를 활성화하면 `v*` annotated tag가 push될 때 버전 공지와 **등록 서버 업데이트** 버튼이 자동으로 표시됩니다. 버튼을 누르면 각 온라인 Connector가 선택된 agent의 부모 채널 아래에 언어별 전용 업데이트 스레드(한국어: `디스코드봇업데이트`)를 찾거나 한 번만 생성합니다. Coordinator는 `computerId`별 전용 스레드 하나에만 exact tagged commit의 안전 업데이트를 요청하므로 사용자가 작업 중인 세션을 침범하지 않습니다. Codex와 Claude Code를 모두 쓰는 서버에도 요청은 한 번만 전송됩니다.

## 파일과 미디어

Discord 메시지에 이미지, 영상, 오디오, 문서 또는 압축 파일을 그냥 첨부하고 원하는 작업을 적으면 됩니다. 봇이 연결된 컴퓨터에 임시 저장한 뒤 agent에게 전달합니다.

세션에서 `/howtouse`를 한 번 실행하면 agent가 결과 파일과 미디어 설문을 Discord로 보내는 형식을 알게 됩니다. 이후에는 자연어로 요청하세요.

```text
결과 영상과 로그 파일을 Discord에 첨부해서 보내줘.
두 결과 영상을 보내고 어느 쪽이 좋은지 선택하게 해줘.
```

- 입력 기본 제한: 메시지당 10개, 파일당 100MiB, 전체 250MiB
- 출력 기본 안전 한도: 파일당 10MiB
- Discord 서버 자체 업로드 제한이 더 작으면 그 제한이 먼저 적용됩니다.
- 큰 파일은 agent에게 압축, 리사이즈, 재인코딩 또는 분할을 요청하세요.

## 알림

전용 private Discord 서버라면 설치 에이전트가 서버 전체의 기본 알림을 **멘션만(Only @mentions)** 으로 설정합니다. 공유 서버에서는 다른 채널과 사용자에게 영향을 줄 수 있으므로 먼저 동의를 받습니다.

- 중요한 중간 설명은 태그 없이 조용히 쌓입니다.
- 질문, 권한 요청, 중간 답변, 최종 완료와 실패는 Operator 역할 멘션으로 알림이 옵니다.
- 긴 최종 답변과 IDE·백그라운드 완료 알림은 잘리지 않도록 순서가 보장된 여러 메시지로 전달됩니다.
- Discord의 사용자별 채널 알림 override는 bot이 변경할 수 없습니다. 예전에 직접 다른 값으로 바꾼 채널만 사용자가 **멘션만**으로 되돌리면 됩니다.

## 여러 컴퓨터 사용

같은 private Discord 서버에서 여러 Mac, Windows와 Ubuntu 서버를 함께 사용할 수 있습니다. 첫 설치가 끝난 뒤 에이전트에게 다음처럼 말하면 됩니다.

```text
Windows 컴퓨터 하나를 이 Discord connector에 추가로 연결해줘.
```

에이전트가 서버 종류와 접속 방법, 작업 폴더, 사용할 agent 조합(Codex만, Claude Code만, 둘 다)을 순서대로 확인하고 기존 Discord 구성을 재사용해 필요한 채널과 서비스를 준비합니다.

서로 다른 컴퓨터의 agent끼리 토론하게 하려면 설치 에이전트에게 Coordinator Bot도 활성화해 달라고 요청하세요. Coordinator는 Discord를 transport로 사용하므로 두 컴퓨터가 서로 직접 네트워크 접속할 필요가 없습니다.

## 주의사항

### 답변 생성 중에는 같은 세션에 다른 화면에서 말 걸지 마세요

Codex Desktop, VS Code, Antigravity 같은 IDE 또는 Discord에서 답변을 생성하고 있는 동안, 다른 화면에서 같은 session ID에 새 메시지를 보내면 두 turn이 겹칠 수 있습니다. 이때 메시지 순서가 바뀌거나 진행 과정과 최종 답변이 예상하지 않은 화면에 나타날 수 있습니다.

현재 답변이 **완전히 종료된 뒤에는** 같은 세션을 Desktop, IDE, Discord 어디에서든 이어서 사용해도 괜찮습니다. 답변이 끝나기 전에 다른 요청도 시작해야 한다면 `/fork` 또는 `/chat-new`로 별도 세션을 만드세요.

### 서비스 종료 범위가 다릅니다

- Discord bot만 재시작하면 실행 중인 작업은 독립 worker에서 계속됩니다.
- Worker 강제 종료나 컴퓨터 재부팅은 실행 중인 agent와 하위 프로세스를 중단할 수 있습니다.

### 권한은 강력합니다

기본 자동화 설정은 agent가 연결된 컴퓨터의 파일과 명령에 폭넓게 접근할 수 있습니다. 공개 Discord 서버나 신뢰하지 않는 역할에는 연결하지 말고, 토큰과 비밀번호를 Discord 메시지로 보내지 마세요.

## 문서

- [AI Agent Guide](docs/AI_AGENT_GUIDE.md): 설치, 업데이트, 서비스 운영과 문제 해결을 위한 에이전트 전용 문서
- [English AI Agent Guide](docs/AI_AGENT_GUIDE.en.md)
- [Localization Guide](docs/localization.md)
- [Agent Relay Guide](docs/agent-relay.ko.md)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## 라이선스

MIT

이 프로젝트는 [joungminsung/codex-discord-connector](https://github.com/joungminsung/codex-discord-connector)의 아이디어와 초기 기반에서 출발했으며, 좋은 출발점을 공개해주신 원작자에게 감사드립니다. 현재 버전은 multi-agent 지원, 독립 worker 구조, 다중 컴퓨터 운영, 파일·미디어 왕복, 다국어 UI와 크로스 플랫폼 배포를 포함해 코드베이스와 사용 흐름 대부분을 폭넓게 재설계하고 확장했습니다.
