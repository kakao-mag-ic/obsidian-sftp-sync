import type {
  FileInfo,
  SyncRecord,
  SyncEntity,
  SyncDecision,
  SftpSyncSettings,
} from "./types";

export interface SyncContext {
  localFiles: FileInfo[];
  remoteFiles: FileInfo[];
  prevRecords: Map<string, SyncRecord>;
  settings: SftpSyncSettings;
}

function hasChanged(file: FileInfo, record: SyncRecord): boolean {
  return file.mtime !== record.mtime || file.size !== record.size;
}

/**
 * Build sync plan: compare local, remote, and previous sync records
 * to determine what action to take for each file.
 */
export function buildSyncPlan(ctx: SyncContext): SyncEntity[] {
  const { localFiles, remoteFiles, prevRecords, settings } = ctx;

  // Index by path
  const localMap = new Map<string, FileInfo>();
  for (const f of localFiles) localMap.set(f.path, f);

  const remoteMap = new Map<string, FileInfo>();
  for (const f of remoteFiles) remoteMap.set(f.path, f);

  // Collect all unique paths
  const allPaths = new Set<string>();
  for (const f of localFiles) allPaths.add(f.path);
  for (const f of remoteFiles) allPaths.add(f.path);
  for (const [p] of prevRecords) allPaths.add(p);

  const plan: SyncEntity[] = [];

  for (const path of allPaths) {
    const local = localMap.get(path);
    const remote = remoteMap.get(path);
    const prev = prevRecords.get(path);

    const entity: SyncEntity = { path, local, remote, prevSync: prev };
    entity.decision = decideAction(entity, settings);
    plan.push(entity);
  }

  return plan;
}

function decideAction(entity: SyncEntity, settings: SftpSyncSettings): SyncDecision {
  const { local, remote, prevSync } = entity;
  const direction = settings.syncDirection;

  // No previous sync record → first sync
  if (!prevSync) {
    return decideFirstSync(entity, settings);
  }

  const localChanged = local ? hasChanged(local, prevSync) : false;
  const remoteChanged = remote ? hasChanged(remote, prevSync) : false;
  const localExists = !!local;
  const remoteExists = !!remote;
  const localDeleted = !localExists;
  const remoteDeleted = !remoteExists;

  // Both exist, neither changed
  if (localExists && remoteExists && !localChanged && !remoteChanged) {
    return "skip";
  }

  if (direction === "pull_only") {
    return decidePullOnly(localExists, remoteExists, localChanged, remoteChanged, remoteDeleted, settings);
  }

  if (direction === "push_only") {
    return decidePushOnly(localExists, remoteExists, localChanged, remoteChanged, localDeleted, settings);
  }

  // bidirectional
  return decideBidirectional(entity, localChanged, remoteChanged, localDeleted, remoteDeleted, settings);
}

function decideFirstSync(entity: SyncEntity, settings: SftpSyncSettings): SyncDecision {
  const { local, remote } = entity;
  const direction = settings.syncDirection;

  if (local && !remote) {
    return direction === "pull_only" ? "skip" : "upload";
  }
  if (!local && remote) {
    return direction === "push_only" ? "skip" : "download";
  }
  if (local && remote) {
    // Both exist on first sync
    if (direction === "pull_only") {
      return remote.mtime > local.mtime ? "download" : "skip";
    }
    if (direction === "push_only") {
      return local.mtime > remote.mtime ? "upload" : "skip";
    }
    // bidirectional: use newer, skip if same
    if (remote.mtime > local.mtime) return "download";
    if (local.mtime > remote.mtime) return "upload";
    return "skip";
  }

  return "skip";
}

function decidePullOnly(
  localExists: boolean,
  remoteExists: boolean,
  _localChanged: boolean,
  remoteChanged: boolean,
  remoteDeleted: boolean,
  settings: SftpSyncSettings,
): SyncDecision {
  // Remote modified → download
  if (remoteExists && remoteChanged) return "download";

  // Remote deleted
  if (remoteDeleted && localExists) {
    return settings.deleteSync ? "delete_local" : "skip";
  }

  // New on remote (no local)
  if (remoteExists && !localExists) return "download";

  return "skip";
}

function decidePushOnly(
  localExists: boolean,
  remoteExists: boolean,
  localChanged: boolean,
  _remoteChanged: boolean,
  localDeleted: boolean,
  settings: SftpSyncSettings,
): SyncDecision {
  if (localExists && localChanged) return "upload";

  if (localDeleted && remoteExists) {
    return settings.deleteSync ? "delete_remote" : "skip";
  }

  if (localExists && !remoteExists) return "upload";

  return "skip";
}

function decideBidirectional(
  entity: SyncEntity,
  localChanged: boolean,
  remoteChanged: boolean,
  localDeleted: boolean,
  remoteDeleted: boolean,
  settings: SftpSyncSettings,
): SyncDecision {
  const { local, remote } = entity;

  // Only remote changed
  if (remoteChanged && !localChanged && !localDeleted) return "download";

  // Only local changed
  if (localChanged && !remoteChanged && !remoteDeleted) return "upload";

  // Remote deleted, local unchanged
  if (remoteDeleted && !localChanged) {
    return settings.deleteSync ? "delete_local" : "skip";
  }

  // Local deleted, remote unchanged
  if (localDeleted && !remoteChanged) {
    return settings.deleteSync ? "delete_remote" : "skip";
  }

  // Both deleted
  if (localDeleted && remoteDeleted) return "skip";

  // Remote deleted, local changed → upload (local wins over deletion)
  if (remoteDeleted && localChanged) return "upload";

  // Local deleted, remote changed → download (remote wins over deletion)
  if (localDeleted && remoteChanged) return "download";

  // Both changed → conflict
  if (localChanged && remoteChanged && local && remote) {
    return resolveConflict(local, remote, settings);
  }

  return "skip";
}

function resolveConflict(
  local: FileInfo,
  remote: FileInfo,
  settings: SftpSyncSettings,
): SyncDecision {
  switch (settings.conflictStrategy) {
    case "newer_wins":
      return remote.mtime >= local.mtime ? "download" : "upload";
    case "larger_wins":
      return remote.size >= local.size ? "download" : "upload";
    case "local_wins":
      return "upload";
    case "remote_wins":
      return "download";
    default:
      return "download";
  }
}
