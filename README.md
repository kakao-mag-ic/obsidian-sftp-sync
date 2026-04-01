# Obsidian SFTP Sync

SSH + rsync를 통해 원격 서버와 Obsidian vault를 양방향 동기화하는 플러그인.
내부망 서버 환경에 최적화되어 있으며, VPN 불안정/서버 재시작 상황을 고려한 설계.

## 주요 기능

- **양방향 실시간 동기화** - 로컬 ↔ 리모트 파일 자동 동기화
- **로컬 파일 감지** - Obsidian의 파일 변경을 감지하여 5초 후 자동 push
- **원격 변경 폴링** - 30초마다 서버 변경 파일을 감지하여 자동 pull
- **rsync 기반 전송** - 변경된 부분만 전송하여 빠르고 효율적
- **SSH find로 파일 목록 수집** - 수천 개 파일도 1초 안에 목록 수집
- **3-way 비교** - 이전 동기화 기록 기반으로 변경/충돌 감지
- **충돌 해결** - newer_wins, larger_wins, local_wins, remote_wins 전략 지원
- **무시 패턴** - `.obsidian`, `.git`, `node_modules` 등 제외
- **SSH 키 인증** - PEM 키 직접 입력 또는 키 파일 경로 지정

## 동작 방식

```
[로컬 파일 수정] → 5초 debounce → rsync push → 서버에 반영
[서버 파일 수정] → 30초 폴링 감지 → rsync pull → 로컬에 반영
[수동 / 주기적]  → 전체 3-way 비교 → rsync로 양방향 동기화
```

## 요구사항

- Obsidian Desktop (v1.4.0 이상)
- Node.js 18+ (빌드 시)
- `rsync` 설치 (macOS 기본 포함, Linux 대부분 기본 포함)
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

# 빌드 결과물 복사 (main.js에 모든 의존성이 번들링되어 있음)
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
| Port | SSH 포트 | `22` |
| Username | SSH 사용자명 | - |
| Private key | SSH 개인키 (PEM) 직접 입력 | - |
| Private key path | 또는 키 파일 경로 (예: `/Users/you/.ssh/id_rsa`) | - |
| Passphrase | 키 암호 (있는 경우) | - |

> **참고**: Private key path에 `~`는 사용할 수 없습니다. 전체 경로를 입력하세요.

### Sync
| 항목 | 설명 | 기본값 |
|---|---|---|
| Remote path | 원격 서버 동기화 경로 | - |
| Auto sync interval | 전체 동기화 간격 (초, 0이면 비활성) | `180` |
| Sync on startup | Obsidian 시작 시 동기화 | `true` |
| Sync direction | `bidirectional` / `pull_only` / `push_only` | `bidirectional` |
| Conflict strategy | 충돌 해결 전략 | `newer_wins` |
| Delete sync | 삭제 동기화 여부 | `false` |

### Filter
| 항목 | 설명 |
|---|---|
| Ignore paths | 무시할 경로 패턴 (줄바꿈 구분) |

기본 무시 목록: `.obsidian`, `.git`, `node_modules`, `__pycache__`, `*.pyc`, `.env`

## 사용법

### 자동 동기화
플러그인 활성화 후 별도 조작 없이 동작합니다:
- **로컬 수정** → 5초 후 자동으로 서버에 push
- **서버 수정** → 30초 이내에 자동으로 로컬에 pull
- **전체 동기화** → 설정 간격(기본 3분)마다 실행

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

## 개발

```bash
# 테스트 실행
npm test

# 개발 빌드 (sourcemap 포함)
node esbuild.config.mjs

# 프로덕션 빌드
node esbuild.config.mjs production
```

## 보안 참고

- SSH 개인키는 base64 인코딩되어 vault의 `.obsidian/plugins/obsidian-sftp-sync/data.json`에 저장됩니다.
- vault를 클라우드 동기화(iCloud, Dropbox 등)하는 경우 키 노출에 주의하세요.
- 가능하면 **Private key path** 방식으로 로컬 키 파일을 참조하는 것을 권장합니다.

## 라이선스

MIT
