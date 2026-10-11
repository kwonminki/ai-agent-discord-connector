# Orca에서 작업하다 Discord로 답변하기

한국어 | [English](orca.en.md)

Direct 모드 Gateway가 Discord 답변을 Orca에서 실행 중인 Codex / Claude Code 터미널에 전달합니다. 기존 CLI가 세션을 계속 사용하므로, 봇이 두 번째 Codex writer를 열지 않습니다. 사용자 계정, SSH 별칭, 개인 경로를 하드코딩하지 않은 공통 기능입니다.

## 사용 방법

1. 커넥터 소스를 업데이트하고 의존성을 설치한 뒤 **Gateway**를 재시작합니다. 시작할 때 `/orca`가 등록됩니다. 이 기능만 적용하려면 Worker를 재시작할 필요는 없습니다.
2. Orca와 원하는 Codex / Claude 터미널을 켠 상태에서 관리되는 Discord 채널/스레드에 `/orca`를 입력하고 터미널을 선택합니다. 이름과 호스트를 확인하세요. `/orca action:connect terminal:term_...`로 정확한 핸들을 지정할 수도 있습니다.
3. **화면 확인** 버튼 또는 `/orca action:read`로 현재 질문을 읽습니다. 일반 메시지로 답하면 해당 터미널에 텍스트와 Enter가 전달됩니다.
4. `/orca action:disconnect`로 해제하면 원래 봇 동작으로 돌아옵니다.

`/orca action:status`는 연결을 확인합니다. `/orca action:send text:...`는 `/compact` 같은 CLI 명령도 그대로 전달합니다. 일반 텍스트 명령 `/orca read`, `/orca send ...`, `/orca disconnect`도 지원합니다. 연결 중에는 다른 봇 slash 명령을 차단하므로, 필요하면 먼저 해제하세요. 스타일/스킬은 실행 중인 Orca CLI의 설정을 따르며 커넥터가 답변 앞에 추가하지 않습니다.

기존 답변 알림을 받으려면 **같은 에이전트 세션에 이미 동기화된 Discord 스레드**에서 연결하세요. Orca 연결 자체가 Codex/Claude 세션 ID를 찾아 다시 연결하거나 채팅을 만들거나 화면을 계속 자동 중계하지는 않습니다. 동기화가 없어도 **화면 확인**은 사용할 수 있습니다. 화살표 등 키 조작이 필요한 대화상자, 인증, 파일 첨부는 Orca에서 처리하세요. 로컬 입력란에 작성하는 동안 Discord에서 동시에 전송하지 마세요.

## 설치별 설정

Orca CLI가 **Gateway 서비스의 사용자 계정과 환경**에서도 실행되어야 합니다. 실행 파일 선택 순서는 다음과 같으며, 실패했다고 다른 설치본으로 넘어가지 않습니다.

1. `CONNECT_ORCA_COMMAND`
2. `.connect/config.json`의 `direct.orca.command`
3. `ORCA_CLI_COMMAND`
4. `ORCA_DEV_REPO_ROOT`가 있으면 `orca-dev`
5. Linux는 `orca-ide`, 나머지는 `orca`

Linux의 일반 `orca`는 GNOME 화면 읽기 프로그램일 수 있어 기본값으로 쓰지 않습니다. 원격 Orca relay를 사용한다면 **그 서버의 Orca 터미널 안에서** `which orca`로 확인한 실행 파일의 절대 경로를 지정하세요. 셸 명령이나 `ssh ...` 문자열을 넣는 설정은 아닙니다. Relay에 필요한 기존 환경과 인증도 유지해야 합니다. 다른 사용자의 경로, 토큰, 채널 연결 정보를 복사하지 마세요.

기존 `.connect/config.json`의 `direct` 객체 안에 아래 항목을 추가합니다. 나머지 설정은 보존하세요.

```json
"orca": { "command": "/absolute/path/to/your/orca-cli", "enabled": true }
```

새 설치에서는 기존 setup 명령에 `--orca-command /absolute/path/to/your/orca-cli`를 추가할 수 있습니다. 환경 변수 방식은 Gateway 서비스 환경에 넣어야 합니다. 사용하지 않는 `.env` 파일을 수정하는 것만으로 적용되지는 않습니다. 설정 후 Gateway를 재시작하세요.

Gateway와 **같은 실행 파일·계정**에서 다음 두 명령이 실행되는지 확인합니다.

```text
<실행파일> skills get orca-cli --json
<실행파일> terminal list --json
```

`CONNECT_ORCA_ENABLED=false` 또는 `direct.orca.enabled=false`로 끌 수 있습니다. 명시한 환경 변수 값이 우선합니다. 꺼도 연결된 채널은 자동으로 새 에이전트 요청을 만들지 않습니다. `/orca disconnect`로 해제하세요. Hub 모드에서는 전달하지 않습니다.

## 복구와 접근 범위

- 목록·연결·화면·입력에 기존 채널 역할 권한이 적용됩니다. 허용된 사람끼리 화면과 입력 권한을 공유하므로 비공개 채널/스레드를 사용하세요. 일반 셸과 Orca가 Codex/Claude로 식별하지 못하는 터미널은 제외합니다.
- Runtime, 터미널 핸들, 프로세스 세대, 호스트, 에이전트를 고정합니다. Gateway만 재시작하면 연결이 유지되지만 Orca나 프로세스가 바뀌면 다시 선택해야 합니다. 한 Gateway에서 같은 터미널은 한 Discord 채널에만 연결할 수 있습니다. 실패 시 다른 터미널이나 새 writer로 넘어가지 않습니다.
- 선택 메뉴는 5분 후 만료되며, 요청한 사용자만 같은 채널에서 선택할 수 있습니다. 해당 채널의 기존 봇 작업이 실행/대기 중이면 연결하지 않습니다.
- 입력 접수와 작업 시작 확인을 구분합니다. 접수는 완료를 뜻하지 않습니다. 전송 중 끊기면 자동 재전송하지 않으므로 화면을 확인한 뒤 필요할 때 새 메시지로 보내세요.
- `.connect/orca-bindings.json`에는 연결 정보와 7일간의 전송 ID/상태를 저장하며 프롬프트와 화면 내용은 저장하지 않습니다. `CONNECT_ORCA_STATE_PATH`로 경로를 바꿀 수 있고, 관리형 실행은 설치 디렉터리의 `.connect`에 저장합니다. 업데이트 때 보존하세요. 비정상 종료 후에도 같은 메시지의 자동 재전송을 막습니다. 7일 지난 메시지와 복원된 기존 봇 대기 요청은 전달하지 않습니다.
- 여러 Gateway가 상태 파일 하나를 공유하지 않게 하세요. 파일이 손상되면 복구 전에는 전달을 막습니다. 결과를 모르는 요청을 재시도하려고 전송 기록을 삭제하지 마세요.
- 화면 확인은 최대 40줄의 현재 화면이며 전체 기록이 아닙니다. 안내 문서, 프로세스 식별 정보, 화면 API가 없는 오래된 Orca는 업데이트가 필요합니다. Orca가 로컬 미전송 초안을 보고하면 전송을 멈춥니다. 초안을 로컬에서 정리하세요. 확인 직후 사람이 터미널 상태를 바꾸는 경합까지 막을 수는 없습니다.
