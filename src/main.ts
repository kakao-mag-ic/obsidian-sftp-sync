import { Notice, Plugin } from "obsidian";
import type { SftpSyncSettings, SyncStatus, FileInfo, SyncRecord } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { SftpSyncSettingTab } from "./settings";
import { SyncState } from "./state";
import { buildSyncPlan } from "./sync";
import { shouldIgnore } from "./ignore";
import {
  testSshConnection,
  listRemoteFiles,
  listRemoteChangedFiles,
  deleteRemoteFiles,
  rsyncPull,
  rsyncPush,
  rsyncFiles,
} from "./remote";
import * as path from "path";
import * as fs from "fs";

export default class SftpSyncPlugin extends Plugin {
  settings: SftpSyncSettings = DEFAULT_SETTINGS;
  syncState: SyncState = new SyncState();
  isSyncing = false;
  statusBarItem: HTMLElement | null = null;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLocalChanges: Set<string> = new Set();

  private recentlyPulled: Set<string> = new Set();
  private recentlyPulledTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private remotePollTimer: number | null = null;
  private lastRemotePollTime: number = Date.now();

  private autoSyncTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar("ready");

    this.addSettingTab(new SftpSyncSettingTab(this.app, this));

    this.addCommand({
      id: "sftp-sync-run",
      name: "Run sync now",
      callback: () => this.runFullSync(),
    });

    this.addCommand({
      id: "sftp-sync-test",
      name: "Test connection",
      callback: () => this.testConnection(),
    });

    this.addRibbonIcon("refresh-cw", "SFTP Sync", () => this.runFullSync());

    if (this.settings.syncOnStartup) {
      setTimeout(() => this.runFullSync(), 5000);
    }

    this.startLocalWatcher();
    this.startRemotePoller();
    this.startAutoSync();
  }

  async onunload(): Promise<void> {
    this.stopAutoSync();
    this.stopRemotePoller();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const timer of this.recentlyPulledTimers.values()) clearTimeout(timer);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  restartTimers(): void {
    this.stopAutoSync();
    this.stopRemotePoller();
    this.startAutoSync();
    this.startRemotePoller();
  }

  private markAsPulled(filePath: string): void {
    this.recentlyPulled.add(filePath);
    const existing = this.recentlyPulledTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.recentlyPulled.delete(filePath);
      this.recentlyPulledTimers.delete(filePath);
    }, 10000);
    this.recentlyPulledTimers.set(filePath, timer);
  }

  private markManyAsPulled(paths: string[]): void {
    for (const p of paths) this.markAsPulled(p);
  }

  async testConnection(): Promise<void> {
    const result = await testSshConnection(this.settings);
    new Notice(result.ok ? "SFTP: Connection successful!" : `SFTP: ${result.message}`);
  }

  // ---- Local file watcher ----

  startLocalWatcher(): void {
    if (this.settings.syncDirection === "pull_only") return;

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (shouldIgnore(file.path, this.settings.ignorePaths)) return;
        if (this.recentlyPulled.has(file.path)) return;
        this.pendingLocalChanges.add(file.path);
        this.scheduleLocalPush();
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (shouldIgnore(file.path, this.settings.ignorePaths)) return;
        if (this.recentlyPulled.has(file.path)) return;
        this.pendingLocalChanges.add(file.path);
        this.scheduleLocalPush();
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (shouldIgnore(file.path, this.settings.ignorePaths)) return;
        if (this.settings.deleteSync) {
          this.pendingLocalChanges.add(`__DELETE__:${file.path}`);
          this.scheduleLocalPush();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!shouldIgnore(file.path, this.settings.ignorePaths) && !this.recentlyPulled.has(file.path)) {
          this.pendingLocalChanges.add(file.path);
        }
        if (!shouldIgnore(oldPath, this.settings.ignorePaths) && this.settings.deleteSync) {
          this.pendingLocalChanges.add(`__DELETE__:${oldPath}`);
        }
        this.scheduleLocalPush();
      })
    );
  }

  private scheduleLocalPush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const debounceMs = (this.settings.pushDebounceSec || 5) * 1000;
    this.debounceTimer = setTimeout(() => this.flushLocalChanges(), debounceMs);
  }

  /**
   * Flush pending local changes: batch push files in a single rsync call,
   * then handle deletions.
   */
  private async flushLocalChanges(): Promise<void> {
    if (this.isSyncing || this.pendingLocalChanges.size === 0) return;

    this.isSyncing = true;
    this.updateStatusBar("syncing");

    const vaultPath = (this.app.vault.adapter as any).getBasePath();
    const changes = new Set(this.pendingLocalChanges);
    this.pendingLocalChanges.clear();

    try {
      // Separate file pushes from deletions
      const filesToPush: string[] = [];
      const filesToDelete: string[] = [];

      for (const change of changes) {
        if (change.startsWith("__DELETE__:")) {
          filesToDelete.push(change.slice("__DELETE__:".length));
        } else {
          filesToPush.push(change);
        }
      }

      let syncedCount = 0;
      let failedCount = 0;

      // Batch push all changed files in ONE rsync call
      if (filesToPush.length > 0) {
        try {
          await rsyncFiles(this.settings, vaultPath, filesToPush, "push");
          // Update records for pushed files
          for (const f of filesToPush) {
            const localFull = path.join(vaultPath, f);
            try {
              const stats = fs.statSync(localFull);
              await this.syncState.setRecord(f, {
                path: f, mtime: stats.mtimeMs, size: stats.size,
              });
            } catch { /* file may have been deleted */ }
          }
          syncedCount += filesToPush.length;
        } catch (err) {
          console.error("SFTP: Failed to push files", err);
          failedCount += filesToPush.length;
        }
      }

      // Batch delete remote files
      if (filesToDelete.length > 0) {
        try {
          await deleteRemoteFiles(this.settings, filesToDelete);
          for (const f of filesToDelete) await this.syncState.deleteRecord(f);
          syncedCount += filesToDelete.length;
        } catch (err) {
          console.error("SFTP: Failed to delete remote files", err);
          failedCount += filesToDelete.length;
        }
      }

      this.updateStatusBar(failedCount > 0 ? "failed" : "success");
      if (syncedCount > 0 || failedCount > 0) {
        const msg = failedCount > 0
          ? `SFTP: Pushed ${syncedCount}, failed ${failedCount}`
          : `SFTP: Pushed ${syncedCount} file(s)`;
        new Notice(msg);
      }
    } catch (err: any) {
      console.error("SFTP push error:", err);
      this.updateStatusBar("failed");
    } finally {
      this.isSyncing = false;
    }
  }

  // ---- Remote polling ----

  startRemotePoller(): void {
    if (this.settings.syncDirection === "push_only") return;

    this.lastRemotePollTime = Date.now();
    const pollMs = (this.settings.pullIntervalSec || 30) * 1000;
    this.remotePollTimer = window.setInterval(
      () => this.pollRemoteChanges(),
      pollMs
    );
    this.registerInterval(this.remotePollTimer);
  }

  stopRemotePoller(): void {
    if (this.remotePollTimer !== null) {
      window.clearInterval(this.remotePollTimer);
      this.remotePollTimer = null;
    }
  }

  private async pollRemoteChanges(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const changedFiles = await listRemoteChangedFiles(
        this.settings,
        this.lastRemotePollTime,
        this.settings.ignorePaths
      );

      if (changedFiles.length === 0) return;

      this.updateStatusBar("syncing");
      const vaultPath = (this.app.vault.adapter as any).getBasePath();

      // Filter out files we just pushed (anti-echo)
      const toPull: FileInfo[] = [];
      for (const rf of changedFiles) {
        const record = await this.syncState.getRecord(rf.path);
        if (record && record.mtime >= rf.mtime) continue;
        toPull.push(rf);
      }

      if (toPull.length === 0) return;

      // Batch pull in ONE rsync call
      const pullPaths = toPull.map((f) => f.path);
      this.markManyAsPulled(pullPaths);
      await rsyncFiles(this.settings, vaultPath, pullPaths, "pull");

      // Update records
      for (const rf of toPull) {
        await this.syncState.setRecord(rf.path, {
          path: rf.path, mtime: rf.mtime, size: rf.size,
        });
      }

      this.lastRemotePollTime = Date.now();
      this.updateStatusBar("success");
      new Notice(`SFTP: Pulled ${toPull.length} file(s)`);
    } catch (err: any) {
      console.error("SFTP remote poll error:", err);
    } finally {
      this.isSyncing = false;
    }
  }

  // ---- Full sync ----

  startAutoSync(): void {
    this.stopAutoSync();
    if (this.settings.autoSyncIntervalSec > 0) {
      this.autoSyncTimer = window.setInterval(
        () => this.runFullSync(),
        this.settings.autoSyncIntervalSec * 1000
      );
      this.registerInterval(this.autoSyncTimer);
    }
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  async runFullSync(): Promise<void> {
    if (this.isSyncing) {
      new Notice("SFTP: Sync already in progress");
      return;
    }

    this.isSyncing = true;
    this.updateStatusBar("syncing");

    const vaultPath = (this.app.vault.adapter as any).getBasePath();

    try {
      const prevRecords = await this.syncState.load();
      const direction = this.settings.syncDirection;
      const ignore = this.settings.ignorePaths;

      if (prevRecords.size === 0 || direction !== "bidirectional") {
        await this.runBulkSync(vaultPath, direction, ignore);
      } else {
        await this.runIncrementalSync(vaultPath, prevRecords, ignore);
      }

      this.lastRemotePollTime = Date.now();
      this.updateStatusBar("success");
    } catch (err: any) {
      console.error("SFTP sync error:", err);
      this.updateStatusBar("failed");
      new Notice(`SFTP: Sync failed - ${err?.message || "Unknown error"}`);
    } finally {
      try {
        await this.rebuildSyncRecords(vaultPath);
      } catch { /* ignore */ }
      this.isSyncing = false;
    }
  }

  private async runBulkSync(
    vaultPath: string,
    direction: string,
    ignorePatterns: string[]
  ): Promise<void> {
    const deleteSync = this.settings.deleteSync;

    if (direction === "push_only") {
      await rsyncPush(this.settings, vaultPath, ignorePatterns, deleteSync);
      new Notice("SFTP: Push complete");
    } else if (direction === "pull_only") {
      await rsyncPull(this.settings, vaultPath, ignorePatterns, deleteSync);
      new Notice("SFTP: Pull complete");
    } else {
      // Bidirectional first sync:
      // rsync pull (remote → local), then rsync push (local → remote)
      // Both use trailing slashes = content sync, no nesting
      await rsyncPull(this.settings, vaultPath, ignorePatterns);
      await rsyncPush(this.settings, vaultPath, ignorePatterns);
      new Notice("SFTP: Initial sync complete");
    }
  }

  /**
   * Incremental sync: 3-way compare, then batch rsync for downloads/uploads.
   * Only 2 rsync calls max (1 pull + 1 push) regardless of file count.
   */
  private async runIncrementalSync(
    vaultPath: string,
    prevRecords: Map<string, SyncRecord>,
    ignorePatterns: string[]
  ): Promise<void> {
    const remoteFiles = await listRemoteFiles(this.settings, ignorePatterns);
    const localFiles = this.collectLocalFiles(vaultPath);

    const plan = buildSyncPlan({
      localFiles, remoteFiles, prevRecords,
      settings: this.settings,
    });

    const toDownload = plan.filter((e) => e.decision === "download").map((e) => e.path);
    const toUpload = plan.filter((e) => e.decision === "upload").map((e) => e.path);
    const toDeleteLocal = plan.filter((e) => e.decision === "delete_local");
    const toDeleteRemote = plan.filter((e) => e.decision === "delete_remote");

    let syncedCount = 0;
    let failedCount = 0;

    // Batch download — ONE rsync call
    if (toDownload.length > 0) {
      try {
        this.markManyAsPulled(toDownload);
        await rsyncFiles(this.settings, vaultPath, toDownload, "pull");
        syncedCount += toDownload.length;
      } catch (err) {
        console.error("SFTP: Failed to pull files", err);
        failedCount += toDownload.length;
      }
    }

    // Batch upload — ONE rsync call
    if (toUpload.length > 0) {
      try {
        await rsyncFiles(this.settings, vaultPath, toUpload, "push");
        syncedCount += toUpload.length;
      } catch (err) {
        console.error("SFTP: Failed to push files", err);
        failedCount += toUpload.length;
      }
    }

    // Delete local files
    for (const entity of toDeleteLocal) {
      try {
        const localFull = path.join(vaultPath, entity.path);
        if (fs.existsSync(localFull)) {
          fs.unlinkSync(localFull);
          syncedCount++;
        }
      } catch (err) {
        console.error(`SFTP: Failed to delete local ${entity.path}`, err);
        failedCount++;
      }
    }

    // Delete remote files — ONE ssh call
    if (toDeleteRemote.length > 0) {
      try {
        await deleteRemoteFiles(this.settings, toDeleteRemote.map((e) => e.path));
        syncedCount += toDeleteRemote.length;
      } catch (err) {
        console.error("SFTP: Failed to delete remote files", err);
        failedCount += toDeleteRemote.length;
      }
    }

    if (syncedCount > 0 || failedCount > 0) {
      const msg = failedCount > 0
        ? `SFTP: Synced ${syncedCount}, failed ${failedCount}`
        : `SFTP: Synced ${syncedCount} file(s)`;
      new Notice(msg);
    }
  }

  private async rebuildSyncRecords(vaultPath: string): Promise<void> {
    const localFiles = this.collectLocalFiles(vaultPath);
    const records = new Map<string, SyncRecord>();
    for (const f of localFiles) {
      records.set(f.path, { path: f.path, mtime: f.mtime, size: f.size });
    }
    await this.syncState.save(records);
  }

  collectLocalFiles(basePath: string, relativeTo?: string): FileInfo[] {
    const base = relativeTo ?? basePath;
    const results: FileInfo[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(basePath, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(basePath, entry.name);
      const relPath =
        basePath === base
          ? entry.name
          : `${path.relative(base, basePath)}/${entry.name}`;

      if (shouldIgnore(relPath, this.settings.ignorePaths)) continue;

      if (entry.isDirectory()) {
        results.push(...this.collectLocalFiles(fullPath, base));
      } else if (entry.isFile()) {
        try {
          const stats = fs.statSync(fullPath);
          results.push({
            path: relPath,
            size: stats.size,
            mtime: stats.mtimeMs,
            isDirectory: false,
          });
        } catch { /* file deleted between readdir and stat */ }
      }
    }

    return results;
  }

  updateStatusBar(status: SyncStatus): void {
    if (!this.statusBarItem) return;

    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, "0")}:${now
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;

    switch (status) {
      case "syncing":
        this.statusBarItem.setText("SFTP: Syncing...");
        break;
      case "success":
        this.statusBarItem.setText(`SFTP: Synced ${time}`);
        break;
      case "failed":
        this.statusBarItem.setText(`SFTP: Failed ${time}`);
        break;
      case "offline":
        this.statusBarItem.setText("SFTP: Offline");
        break;
      default:
        this.statusBarItem.setText("SFTP: Ready");
    }
  }
}
