# Obsidian SFTP Sync

SSH + rsync를 통해 원격 서버와 Obsidian vault를 양방향 동기화하는 플러그인.
내부망 서버 환경에 최적화되어 있으며, VPN 불안정/서버 재시작 상황을 고려한 설계.

## 주요 기능

- **양방향 실시간 동기화** - 로컬 ↔ 리모트 파일 자동 동기화
- **로컬 파일 감지** - Obsidian의 파일 변경을 감지하여 자동 push (debounce 설정 가능)
- **원격 변경 폴링** - 주기적으로 서버 변경 파일을 감지하여 자동 pull (간격 설정 가능)
- **배치 rsync 전송** - `--files-from`으로 변경 파일을 모아서 **rsync 1회**로 전송
- **SSH find로 파일 목록 수집** - 수천 개 파일도 1초 안에 목록 수집
- **3-way 비교** - 이전 동기화 기록 기반으로 변경/충돌 감지
- **충돌 해결** - newer_wins, larger_wins, local_wins, remote_wins 전략 지원
- **대용량 파일 스킵** - 설정한 크기 이상의 파일 자동 제외 (기본 100MB)
- **무시 패턴** - `.obsidian`, `.git`, `node_modules` 등 제외
- **SSH 키 인증** - PEM 키 직접 입력 또는 키 파일 경로 지정

## 동작 방식

```
[로컬 파일 수정] → debounce 대기 → rsync --files-from (1회) → 서버에 반영
[서버 파일 수정] → 폴링 감지     → rsync --files-from (1회) → 로컬에 반영
[수동 / 주기적]  → 3-way 비교   → rsync 최대 2회 (pull 1 + push 1)
[첫 동기화]      → rsync bulk   → 단일 호출로 전체 동기화
```

## 요구사항

- Obsidian Desktop (v1.4.0 이상)
- Node.js 18+ (빌드 시)
- `rsync` (macOS 기본 포함, Linux 대부분 기본 포함)
- `ssh` (macOS/Linux 기본 포함)
- SSH 키 인증이 가능한 원격 서버

## 설치

### 1. 빌드

```bash
git clone https://github.com/kakao-mag-ic/obsidian-sftp-sync.git
cd obsidian-sftp-sync
npm install
node esbuild.config.mjs production
```

### 2. 플러그인 폴더에 설치

```bash
# 플러그인 디렉토리 생성
mkdir -p <your-vault>/.obsidian/plugins/obsidian-sftp-sync

# 빌드 결과물 복사 (main.js 단일 파일, 외부 의존성 없음)
cp main.js manifest.json <your-vault>/.obsidian/plugins/obsidian-sftp-sync/
```

> `<your-vault>`는 본인의 Obsidian vault 경로로 대체하세요.
> 예: `~/Documents/MyVault`

### 3. Obsidian에서 활성화

1. Obsidian 열기
2. **Settings** → **Community plugins**
3. **Restricted mode**가 꺼져있는지 확인
4. **Reload plugins** 클릭
5. **SFTP Sync** 토글 켜기

## 설정

Settings → SFTP Sync에서 설정 가능:

### Connection
| 항목 | 설명 | 기본값 |
|---|---|---|
| Host | SSH 서버 주소 | - |
| Port | SSH 포트 (1-65535) | `22` |
| Username | SSH 사용자명 | - |
| Private key | SSH 개인키 (PEM) 직접 입력 | - |
| Private key path | 또는 키 파일 전체 경로 | - |
| Passphrase | 키 암호 (있는 경우) | - |

> **참고**: Private key path에 `~`는 사용할 수 없습니다. `/Users/you/.ssh/id_rsa` 형태로 입력하세요.

### Sync
| 항목 | 설명 | 기본값 |
|---|---|---|
| Remote path | 원격 서버 동기화 경로 (절대경로) | - |
| Auto sync interval | 전체 동기화 간격 (초, 0이면 비활성, 최소 10) | `180` |
| Sync on startup | Obsidian 시작 시 동기화 | `true` |
| Sync direction | `bidirectional` / `pull_only` / `push_only` | `bidirectional` |
| Conflict strategy | 충돌 해결 전략 | `newer_wins` |
| Delete sync | 삭제 동기화 여부 | `false` |
| Push debounce | 로컬 변경 후 push까지 대기 시간 (초, 최소 1) | `5` |
| Pull interval | 서버 변경 확인 폴링 주기 (초, 최소 5) | `30` |
| Max file size | 이 크기 초과 파일 스킵 (MB, 0이면 제한 없음) | `100` |

### Filter
| 항목 | 설명 |
|---|---|
| Ignore paths | 무시할 경로 패턴 (줄바꿈 구분) |

기본 무시 목록: `.obsidian`, `.git`, `node_modules`, `__pycache__`, `*.pyc`, `.env`

> **팁**: 대용량 프로젝트에서 첫 동기화가 느리다면 Max file size를 `10`MB로 낮추거나, Ignore paths에 불필요한 폴더 (`models/`, `tensorboard`, `*.mp4` 등)를 추가하세요.

### Advanced
| 항목 | 설명 | 기본값 |
|---|---|---|
| Strict host key checking | 서버 신원 검증 (끄면 MITM 위험) | `false` |
| Connection timeout | SSH 연결 타임아웃 (ms, 최소 1000) | `5000` |
| Max retries | 연결 실패 시 최대 재시도 횟수 | `2` |

## 사용법

### 자동 동기화
플러그인 활성화 후 별도 조작 없이 동작합니다:
- **로컬 수정** → Push debounce(기본 5초) 후 자동으로 서버에 push
- **서버 수정** → Pull interval(기본 30초) 이내에 자동으로 로컬에 pull
- **전체 동기화** → Auto sync interval(기본 3분)마다 실행

### 수동 동기화
- 좌측 리본의 **새로고침 아이콘** 클릭
- 또는 커맨드 팔레트에서 **SFTP Sync: Run sync now** 실행

### 연결 테스트
- 커맨드 팔레트에서 **SFTP Sync: Test connection** 실행
- 또는 설정 화면의 **Test** 버튼 클릭

### 상태바
화면 하단 상태바에서 동기화 상태 확인:
- `SFTP: Ready` - 대기 중
- `SFTP: Syncing...` - 동기화 중
- `SFTP: Synced 12:34` - 마지막 성공 시각
- `SFTP: Failed 12:34` - 마지막 실패 시각
- `SFTP: Offline` - 서버 연결 불가

## 아키텍처

```
main.js (121kb, 외부 의존성 없음)
├── ssh 바이너리 → 파일 목록 수집 (find), 원격 삭제 (rm)
├── rsync 바이너리 → 파일 전송 (--files-from으로 배치)
└── localforage → 동기화 기록 (IndexedDB)
```

- **ssh2 라이브러리 미사용** — 네이티브 바인딩 문제 없음
- **node_modules 불필요** — main.js 단일 파일로 동작
- 설정 변경 시 타이머 자동 재시작 (플러그인 리로드 불필요)

## 개발

```bash
# 테스트 실행 (68개)
npm test

# 개발 빌드 (sourcemap 포함)
node esbuild.config.mjs

# 프로덕션 빌드
node esbuild.config.mjs production
```

## 보안

- SSH 개인키는 base64 인코딩되어 `data.json`에 저장됩니다
- 가능하면 **Private key path** 방식으로 로컬 키 파일을 참조하는 것을 권장합니다
- vault를 클라우드 동기화(iCloud, Dropbox 등)하는 경우 키 노출에 주의하세요
- 쉘 명령어에 전달되는 모든 경로는 이스케이프 처리됩니다
- `../`가 포함된 원격 경로는 거부됩니다 (경로 탈출 방지)
- symlink는 동기화에서 제외됩니다

## 라이선스

MIT
