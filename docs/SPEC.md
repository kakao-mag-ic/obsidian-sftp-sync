# obsidian-sftp-sync - 구현 스펙

## 개요

SSH/SFTP를 통해 원격 서버와 Obsidian vault를 양방향 동기화하는 Obsidian 플러그인.
내부망 서버 환경에 최적화되어 있으며, VPN 연결 불안정/서버 재시작 상황을 고려한 설계.

## 기술 스택

| 항목 | 선택 | 이유 |
|---|---|---|
| 언어 | TypeScript | Obsidian 플러그인 표준 |
| SFTP 라이브러리 | `ssh2-sftp-client` (wraps `ssh2`) | Node.js SFTP 표준, SSH 키 인증 지원 |
| 빌드 | esbuild | 빠르고 단순, remotely-save도 사용 |
| 동시성 제어 | `p-queue` | 파일 전송 동시성 제한 |
| 로컬 상태 저장 | IndexedDB (`localforage`) | 이전 동기화 상태 기록 |

## 프로젝트 구조

```
obsidian-sftp-sync/
├── src/
│   ├── main.ts              # 플러그인 진입점 (SftpSyncPlugin)
│   ├── types.ts             # 타입 정의
│   ├── settings.ts          # 설정 탭 UI
│   ├── sftp.ts              # SFTP 연결 및 파일 조작
│   ├── sync.ts              # 동기화 알고리즘
│   ├── state.ts             # 로컬 동기화 상태 관리 (IndexedDB)
│   └── ignore.ts            # 무시 패턴 처리
├── docs/
│   └── SPEC.md              # 이 문서
├── manifest.json
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
└── .gitignore
```

---

## 1. 설정 (Settings)

### 1.1 설정 항목

```typescript
interface SftpSyncSettings {
  // 연결
  host: string;              // 기본값: ""
  port: number;              // 기본값: 22
  username: string;          // 기본값: ""
  privateKey: string;        // SSH 개인키 내용 (PEM 문자열)
  privateKeyPath: string;    // 또는 키 파일 경로 (둘 중 하나 사용)
  passphrase: string;        // 키 암호 (있는 경우)

  // 경로
  remotePath: string;        // 기본값: ""

  // 동기화
  autoSyncIntervalSec: number;  // 자동 동기화 간격 (초). 기본값: 180 (3분)
  syncOnStartup: boolean;       // Obsidian 시작 시 동기화. 기본값: true
  syncDirection: "bidirectional" | "pull_only" | "push_only";  // 기본값: "bidirectional"
  conflictStrategy: "newer_wins" | "larger_wins" | "local_wins" | "remote_wins";  // 기본값: "newer_wins"
  deleteSync: boolean;          // 삭제 동기화 여부. 기본값: false (안전 우선)

  // 필터
  ignorePaths: string[];     // 무시할 경로 패턴. 기본값: [".obsidian", ".git", "node_modules", "__pycache__", "*.pyc", ".env"]

  // 연결
  connectTimeoutMs: number;  // 연결 타임아웃. 기본값: 5000
  maxRetries: number;        // 최대 재시도 횟수. 기본값: 2
}
```

### 1.2 설정 UI

Obsidian PluginSettingTab을 사용한 설정 화면:

- **Connection** 섹션: host, port, username, privateKey(textarea), privateKeyPath, passphrase
  - "Test Connection" 버튼 → 연결 성공/실패 결과 표시
- **Remote Path** 섹션: remotePath 입력
  - "Browse" 버튼 → 원격 디렉토리 목록 표시 (있으면 좋지만 MVP에서는 생략 가능)
- **Sync** 섹션: 간격, 방향, 충돌 전략, 삭제 동기화 토글
- **Filter** 섹션: ignorePaths 편집 (줄바꿈으로 구분)

### 1.3 설정 저장

Obsidian 표준 방식 (`this.loadData()` / `this.saveData()`)으로 vault의 `.obsidian/plugins/obsidian-sftp-sync/data.json`에 저장.
privateKey는 민감 정보이므로 base64 인코딩하여 저장 (완전한 암호화는 아니지만 plain text 노출 방지).

---

## 2. SFTP 연결 관리 (sftp.ts)

### 2.1 연결 생명주기

```
[Obsidian 시작] → connect() → [동기화] → disconnect()
                                  ↓
                           [인터벌 대기]
                                  ↓
                        connect() → [동기화] → disconnect()
                                  ↓
                           (서버 끊김)
                                  ↓
                        connect() → 실패 → 스킵, 다음 인터벌에 재시도
```

**원칙**: 동기화할 때만 연결하고, 동기화 끝나면 즉시 해제. 상시 연결 유지하지 않음.
→ 서버 종료/VPN 끊김에 강건하게 대응.

### 2.2 SftpClient 래퍼

```typescript
class SftpConnection {
  // 연결
  async connect(): Promise<boolean>   // 성공 여부 반환, 실패 시 throw 없이 false
  async disconnect(): Promise<void>
  async testConnection(): Promise<{ ok: boolean; message: string }>

  // 파일 조작
  async list(remotePath: string): Promise<FileInfo[]>       // 재귀적 파일 목록
  async stat(remotePath: string): Promise<FileInfo | null>   // 단일 파일 정보
  async download(remotePath: string, localPath: string): Promise<void>
  async upload(localPath: string, remotePath: string): Promise<void>
  async mkdir(remotePath: string): Promise<void>             // 재귀적 생성
  async delete(remotePath: string): Promise<void>
  async exists(remotePath: string): Promise<boolean>
}

interface FileInfo {
  path: string;       // 상대 경로 (remotePath 기준)
  size: number;
  mtime: number;      // Unix timestamp (ms)
  isDirectory: boolean;
}
```

### 2.3 에러 처리

- 연결 타임아웃: `connectTimeoutMs` 이내에 연결 안 되면 실패 처리
- 동기화 중 연결 끊김: 현재 작업 중단, 부분 동기화 상태 기록하지 않음
- 재시도: 연결 실패 시 `maxRetries`만큼 재시도 후 포기

---

## 3. 동기화 알고리즘 (sync.ts)

remotely-save의 3-way 비교 알고리즘을 단순화하여 적용.

### 3.1 상태 모델

```typescript
interface SyncRecord {
  path: string;
  mtime: number;       // 마지막 동기화 시점의 mtime
  size: number;        // 마지막 동기화 시점의 size
  hash?: string;       // 선택: 내용 해시 (mtime만으로 부족한 경우)
}

interface SyncEntity {
  path: string;
  local?: FileInfo;        // 로컬 파일 정보 (없으면 로컬에 없음)
  remote?: FileInfo;       // 리모트 파일 정보 (없으면 리모트에 없음)
  prevSync?: SyncRecord;   // 이전 동기화 기록 (없으면 첫 동기화)
  decision?: SyncDecision;
}

type SyncDecision =
  | "skip"                      // 변경 없음
  | "download"                  // 리모트 → 로컬
  | "upload"                    // 로컬 → 리모트
  | "delete_local"              // 로컬에서 삭제 (리모트에서 삭제됨)
  | "delete_remote"             // 리모트에서 삭제 (로컬에서 삭제됨)
  | "conflict_use_newer"        // 충돌: 최신 파일 사용
  | "conflict_use_local"        // 충돌: 로컬 우선
  | "conflict_use_remote"       // 충돌: 리모트 우선
```

### 3.2 동기화 흐름

```
1. connect()
2. walk: 로컬 파일 목록 수집
3. walk: 리모트 파일 목록 수집 (SFTP)
4. load: 이전 동기화 기록 로드 (IndexedDB)
5. merge: 3개 목록을 path 기준으로 합쳐 SyncEntity[] 생성
6. plan: 각 SyncEntity에 SyncDecision 할당
7. execute: 결정에 따라 파일 전송/삭제 실행
   - 폴더 생성 (얕은 것부터)
   - 삭제 (깊은 것부터)
   - 파일 업로드/다운로드 (p-queue로 동시성 제어)
8. record: 성공한 항목의 동기화 기록 갱신 (IndexedDB)
9. disconnect()
```

### 3.3 결정 매트릭스 (bidirectional 모드)

이전 동기화 기록(prevSync) 대비 로컬/리모트 변경 여부를 비교:

| 로컬 \ 리모트 | 변경 없음 | 수정됨 | 삭제됨 | 새로 생김 |
|---|---|---|---|---|
| **변경 없음** | skip | download | delete_local* | download |
| **수정됨** | upload | **conflict** | upload | **conflict** |
| **삭제됨** | delete_remote* | download | skip (양쪽 삭제) | download |
| **새로 생김** | upload | **conflict** | upload | **conflict** |

*삭제 동기화는 `deleteSync: true`인 경우만. false이면 삭제된 쪽을 복원함.

**변경 판정 기준**: prevSync 대비 mtime 또는 size 변경

**충돌 해결**: `conflictStrategy` 설정에 따라:
- `newer_wins`: mtime이 더 큰 쪽 사용
- `larger_wins`: size가 더 큰 쪽 사용
- `local_wins`: 항상 로컬 우선
- `remote_wins`: 항상 리모트 우선

### 3.4 첫 동기화 (prevSync 없음)

이전 기록이 없는 파일의 처리:
- 로컬에만 있음 → upload
- 리모트에만 있음 → download
- 양쪽 다 있음 → mtime 비교하여 최신 것 사용, 같으면 skip

---

## 4. 로컬 상태 관리 (state.ts)

### 4.1 IndexedDB 구조

`localforage`를 사용하여 Obsidian의 IndexedDB에 저장.

```
Store: "sftp-sync-records"
Key: file path (string)
Value: SyncRecord { path, mtime, size, hash? }
```

### 4.2 API

```typescript
class SyncState {
  async load(): Promise<Map<string, SyncRecord>>
  async save(records: Map<string, SyncRecord>): Promise<void>
  async getRecord(path: string): Promise<SyncRecord | null>
  async setRecord(path: string, record: SyncRecord): Promise<void>
  async deleteRecord(path: string): Promise<void>
  async clear(): Promise<void>  // 전체 초기화 (설정에서 "Reset Sync History" 버튼)
}
```

---

## 5. 무시 패턴 (ignore.ts)

### 5.1 기본 무시 목록

```
.obsidian/          # Obsidian 설정 (동기화하면 충돌 위험)
.git/               # Git 데이터
.gitignore
node_modules/
__pycache__/
*.pyc
.env
.DS_Store
Thumbs.db
```

### 5.2 패턴 매칭

`micromatch` 또는 간단한 glob 매칭 사용:
- `*` → 단일 디렉토리 내 아무 파일
- `**` → 재귀적
- `/` 로 끝나면 디렉토리만 매칭
- `!` 접두사로 제외에서 복원

```typescript
function shouldIgnore(path: string, patterns: string[]): boolean
```

---

## 6. 플러그인 생명주기 (main.ts)

### 6.1 Plugin 클래스

```typescript
class SftpSyncPlugin extends Plugin {
  settings: SftpSyncSettings;
  syncState: SyncState;
  autoSyncTimer: number | null;
  isSyncing: boolean;          // 중복 실행 방지 락
  statusBarItem: HTMLElement;

  async onload(): Promise<void>
  async onunload(): Promise<void>
  async loadSettings(): Promise<void>
  async saveSettings(): Promise<void>

  // 동기화
  async runSync(): Promise<void>        // 메인 동기화 실행
  startAutoSync(): void                 // 자동 동기화 타이머 시작
  stopAutoSync(): void                  // 타이머 중지

  // UI 업데이트
  updateStatusBar(status: SyncStatus): void
}
```

### 6.2 onload() 흐름

```
1. loadSettings()
2. SyncState 초기화
3. 상태바 아이템 추가 ("SFTP: Ready")
4. 설정 탭 등록
5. 커맨드 등록:
   - "sftp-sync: Run sync now" (Ctrl/Cmd+Shift+S)
   - "sftp-sync: Test connection"
6. 리본 아이콘 추가 (클릭 시 수동 동기화)
7. syncOnStartup이면 → 5초 후 첫 동기화 실행
8. startAutoSync()
```

### 6.3 onunload() 흐름

```
1. stopAutoSync()
2. SFTP 연결 해제 (있으면)
3. 상태바 아이템 제거
```

### 6.4 상태바 표시

```
동기화 중:     "SFTP: Syncing..."
성공:         "SFTP: Synced 12:34"       (마지막 성공 시각)
실패:         "SFTP: Failed 12:34"       (마지막 실패 시각)
연결 불가:     "SFTP: Offline"
비활성:        "SFTP: Ready"
```

---

## 7. 커맨드 & 단축키

| 커맨드 ID | 이름 | 단축키 | 설명 |
|---|---|---|---|
| `sftp-sync-run` | Run sync now | - | 수동 동기화 실행 |
| `sftp-sync-test` | Test connection | - | 연결 테스트 |

---

## 8. 보안 고려사항

- **SSH 키 저장**: `data.json`에 base64 인코딩하여 저장. vault가 로컬에만 있으므로 허용 가능.
  사용자에게 설정 시 경고 문구 표시: "Private key will be stored in the plugin's data file."
- **비밀번호/패스프레이즈**: 입력 필드를 `type="password"`로 설정
- **네트워크**: SSH 프로토콜 자체가 암호화되므로 추가 암호화 불필요

---

## 9. 에러 시나리오 & 대응

| 시나리오 | 대응 |
|---|---|
| VPN 끊김 (연결 실패) | connect() → false → 이번 주기 스킵, 다음 주기에 재시도 |
| 서버 종료 | 위와 동일 |
| 동기화 중 연결 끊김 | 현재 작업 중단, 동기화 기록 갱신하지 않음 (다음 주기에 재시도) |
| 대용량 파일 | 100MB 이상 파일은 자동 스킵 (설정 가능) |
| 권한 오류 | 해당 파일 스킵, 로그 기록 |
| 동시 동기화 요청 | `isSyncing` 플래그로 중복 실행 방지 |
| Mac 슬립 후 복귀 | setInterval이 자동 재개 → 다음 인터벌에 정상 동기화 |

---

## 10. 구현 우선순위

### Phase 1: MVP (핵심 기능)

1. 프로젝트 셋업 (package.json, tsconfig, esbuild, manifest.json)
2. SFTP 연결 (`sftp.ts`) - connect, disconnect, list, download, upload
3. 설정 UI (`settings.ts`) - 연결 정보 + Test Connection
4. 단방향 동기화: pull only (`sync.ts`) - 리모트 → 로컬 다운로드
5. 상태바 표시

### Phase 2: 양방향 동기화

6. 로컬 파일 목록 수집
7. IndexedDB 상태 관리 (`state.ts`)
8. 3-way 비교 알고리즘
9. 양방향 동기화 (upload + download)
10. 충돌 해결

### Phase 3: 자동화 & 안정성

11. 자동 동기화 타이머
12. Obsidian 시작 시 동기화
13. 무시 패턴 (`ignore.ts`)
14. 에러 처리 강화
15. 커맨드 팔레트 통합

---

## 11. 의존성

```json
{
  "dependencies": {
    "ssh2-sftp-client": "^11.0.0",
    "localforage": "^1.10.0",
    "p-queue": "^8.0.0"
  },
  "devDependencies": {
    "obsidian": "^1.4.0",
    "@types/node": "^20.0.0",
    "@types/ssh2-sftp-client": "^9.0.0",
    "typescript": "^5.0.0",
    "esbuild": "^0.20.0"
  }
}
```

---

## 12. 제약 사항 & 가정

- Obsidian Desktop 전용 (`isDesktopOnly: true`) — Node.js API (ssh2) 필요
- SSH 키 인증만 지원 (비밀번호 인증은 추후 추가 가능)
- 단일 서버만 지원 (다중 서버 불필요)
- `.obsidian/` 디렉토리는 동기화하지 않음 (설정 충돌 방지)
- 바이너리 파일도 동기화하지만, 100MB 초과 파일은 기본 스킵
