export interface SftpSyncSettings {
  // Connection
  host: string;
  port: number;
  username: string;
  privateKey: string;
  privateKeyPath: string;
  passphrase: string;

  // Path
  remotePath: string;

  // Sync
  autoSyncIntervalSec: number;
  syncOnStartup: boolean;
  syncDirection: "bidirectional" | "pull_only" | "push_only";
  conflictStrategy: "newer_wins" | "larger_wins" | "local_wins" | "remote_wins";
  deleteSync: boolean;

  // Filter
  ignorePaths: string[];

  // Connection tuning
  connectTimeoutMs: number;
  maxRetries: number;
}

export const DEFAULT_SETTINGS: SftpSyncSettings = {
  host: "kap-instance.dev.9rum.cc",
  port: 36595,
  username: "bc-user",
  privateKey: "",
  privateKeyPath: "",
  passphrase: "",
  remotePath:
    "/data/ib-a100-cluster-b-pri-vcga_940/workspace/mag/Github/DiffSynth-Distill",
  autoSyncIntervalSec: 180,
  syncOnStartup: true,
  syncDirection: "bidirectional",
  conflictStrategy: "newer_wins",
  deleteSync: false,
  ignorePaths: [
    ".obsidian",
    ".git",
    "node_modules",
    "__pycache__",
    "*.pyc",
    ".env",
  ],
  connectTimeoutMs: 5000,
  maxRetries: 2,
};

export interface FileInfo {
  path: string;
  size: number;
  mtime: number;
  isDirectory: boolean;
}

export interface SyncRecord {
  path: string;
  mtime: number;
  size: number;
  hash?: string;
}

export interface SyncEntity {
  path: string;
  local?: FileInfo;
  remote?: FileInfo;
  prevSync?: SyncRecord;
  decision?: SyncDecision;
}

export type SyncDecision =
  | "skip"
  | "download"
  | "upload"
  | "delete_local"
  | "delete_remote"
  | "conflict_use_newer"
  | "conflict_use_local"
  | "conflict_use_remote";

export type SyncStatus =
  | "ready"
  | "syncing"
  | "success"
  | "failed"
  | "offline";
