# Obsidian SFTP Sync

SSH/SFTP를 통해 원격 서버와 Obsidian vault를 양방향 동기화하는 플러그인.
내부망 서버 환경에 최적화되어 있으며, VPN 불안정/서버 재시작 상황을 고려한 설계.

## 주요 기능

- **양방향 동기화** - 로컬 ↔ 리모트 파일 자동 동기화
- **3-way 비교** - 이전 동기화 기록 기반으로 변경/충돌 감지
- **충돌 해결** - newer_wins, larger_wins, local_wins, remote_wins 전략 지원
- **자동 동기화** - 설정한 간격(기본 3분)마다 자동 실행
- **무시 패턴** - `.obsidian`, `.git`, `node_modules` 등 제외
- **SSH 키 인증** - PEM 키 직접 입력 또는 키 파일 경로 지정

## 요구사항

- Obsidian Desktop (v1.4.0 이상)
- Node.js 18+ (빌드 시)
- SSH 키 인증이 가능한 원격 서버

## 설치

### 1. 빌드

```bash
git clone <repo-url>
cd obsidian-sftp-sync
npm install
node esbuild.config.mjs production
```

### 2. 플러그인 폴더에 설치

```bash
# 플러그인 디렉토리 생성
mkdir -p <your-vault>/.obsidian/plugins/obsidian-sftp-sync

# 빌드 결과물 복사
cp main.js manifest.json <your-vault>/.obsidian/plugins/obsidian-sftp-sync/

# ssh2 네이티브 모듈 설치 (플러그인 폴더에서 실행)
cd <your-vault>/.obsidian/plugins/obsidian-sftp-sync
npm init -y
npm install ssh2-sftp-client
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
| Host | SFTP 서버 주소 | - |
| Port | SFTP 포트 | `22` |
| Username | SSH 사용자명 | - |
| Private key | SSH 개인키 (PEM) 직접 입력 | - |
| Private key path | 또는 키 파일 경로 | - |
| Passphrase | 키 암호 (있는 경우) | - |

### Sync
| 항목 | 설명 | 기본값 |
|---|---|---|
| Remote path | 원격 서버 동기화 경로 | - |
| Auto sync interval | 자동 동기화 간격 (초, 0이면 비활성) | `180` |
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
