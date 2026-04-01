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
  rsyncPullFile,
  rsyncPushFile,
} from "./remote";
import * as path from "path";
import * as fs from "fs";

export default class SftpSyncPlugin extends Plugin {
  settings: SftpSyncSettings = DEFAULT_SETTINGS;
  syncState: SyncState = new SyncState();
  isSyncing = false;
  statusBarItem: HTMLElement | null = null;

  // File watcher
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLocalChanges: Set<string> = new Set();

  // Anti-echo: files recently pulled from remote, skip in local watcher
  private recentlyPulled: Set<string> = new Set();
  private recentlyPulledTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Remote polling
  private remotePollTimer: number | null = null;
  private lastRemotePollTime: number = Date.now();

  // Full sync timer
  private autoSyncTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Status bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar("ready");

    // Settings tab
    this.addSettingTab(new SftpSyncSettingTab(this.app, this));

    // Commands
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

    // Ribbon icon
    this.addRibbonIcon("refresh-cw", "SFTP Sync", () => this.runFullSync());

    // Startup sync
    if (this.settings.syncOnStartup) {
      setTimeout(() => this.runFullSync(), 5000);
    }

    // Start watchers
    this.startLocalWatcher();
    this.startRemotePoller();
    this.startAutoSync();
  }

  async onunload(): Promise<void> {
    this.stopAutoSync();
    this.stopRemotePoller();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const timer of this.recentlyPulledTimers.values()) {
      clearTimeout(timer);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---- Anti-echo helpers ----

  private markAsPulled(filePath: string): void {
    this.recentlyPulled.add(filePath);
    // Clear after 10 seconds
    const existing = this.recentlyPulledTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.recentlyPulled.delete(filePath);
      this.recentlyPulledTimers.delete(filePath);
    }, 10000);
    this.recentlyPulledTimers.set(filePath, timer);
  }

  // ---- Connection test ----

  async testConnection(): Promise<void> {
    const result = await testSshConnection(this.settings);
    new Notice(result.ok ? "SFTP: Connection successful!" : `SFTP: ${result.message}`);
  }

  // ---- Local file watcher ----

  startLocalWatcher(): void {
    const direction = this.settings.syncDirection;
    if (direction === "pull_only") return;

    // Watch for file modifications
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (shouldIgnore(file.path, this.settings.ignorePaths)) return;
        if (this.recentlyPulled.has(file.path)) return; // anti-echo
        this.pendingLocalChanges.add(file.path);
        this.scheduleLocalPush();
      })
    );

    // Watch for new files
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (shouldIgnore(file.path, this.settings.ignorePaths)) return;
        if (this.recentlyPulled.has(file.path)) return; // anti-echo
        this.pendingLocalChanges.add(file.path);
        this.scheduleLocalPush();
      })
    );

    // Watch for deletions
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (shouldIgnore(file.path, this.settings.ignorePaths)) return;
        if (this.settings.deleteSync) {
          this.pendingLocalChanges.add(`__DELETE__:${file.path}`);
          this.scheduleLocalPush();
        }
      })
    );

    // Watch for renames
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!shouldIgnore(file.path, this.settings.ignorePaths)) {
          if (!this.recentlyPulled.has(file.path)) {
            this.pendingLocalChanges.add(file.path);
          }
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

  private async flushLocalChanges(): Promise<void> {
    if (this.isSyncing || this.pendingLocalChanges.size === 0) return;

    this.isSyncing = true;
    this.updateStatusBar("syncing");

    const vaultPath = (this.app.vault.adapter as any).getBasePath();
    const changes = new Set(this.pendingLocalChanges);
    this.pendingLocalChanges.clear();

    try {
      let syncedCount = 0;

      for (const change of changes) {
        if (change.startsWith("__DELETE__:")) {
          const filePath = change.slice("__DELETE__:".length);
          try {
            await deleteRemoteFiles(this.settings, [filePath]);
            await this.syncState.deleteRecord(filePath);
            syncedCount++;
          } catch (err) {
            console.error(`SFTP: Failed to delete remote ${filePath}`, err);
          }
        } else {
          try {
            await rsyncPushFile(this.settings, vaultPath, change);
            const localFull = path.join(vaultPath, change);
            if (fs.existsSync(localFull)) {
              const stats = fs.statSync(localFull);
              await this.syncState.setRecord(change, {
                path: change,
                mtime: stats.mtimeMs,
                size: stats.size,
              });
            }
            syncedCount++;
          } catch (err) {
            console.error(`SFTP: Failed to push ${change}`, err);
          }
        }
      }

      this.updateStatusBar("success");
      if (syncedCount > 0) {
        new Notice(`SFTP: Pushed ${syncedCount} file(s)`);
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
    const direction = this.settings.syncDirection;
    if (direction === "push_only") return;

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

    try {
      const changedFiles = await listRemoteChangedFiles(
        this.settings,
        this.lastRemotePollTime,
        this.settings.ignorePaths
      );

      if (changedFiles.length === 0) return;

      this.isSyncing = true;
      this.updateStatusBar("syncing");

      const vaultPath = (this.app.vault.adapter as any).getBasePath();
      let syncedCount = 0;

      for (const remoteFile of changedFiles) {
        // Check if this file was just pushed by us (avoid echo)
        const record = await this.syncState.getRecord(remoteFile.path);
        if (record && record.mtime >= remoteFile.mtime) continue;

        try {
          this.markAsPulled(remoteFile.path); // anti-echo: suppress local watcher
          await rsyncPullFile(this.settings, vaultPath, remoteFile.path);
          await this.syncState.setRecord(remoteFile.path, {
            path: remoteFile.path,
            mtime: remoteFile.mtime,
            size: remoteFile.size,
          });
          syncedCount++;
        } catch (err) {
          console.error(`SFTP: Failed to pull ${remoteFile.path}`, err);
        }
      }

      this.lastRemotePollTime = Date.now();
      this.updateStatusBar("success");
      if (syncedCount > 0) {
        new Notice(`SFTP: Pulled ${syncedCount} file(s)`);
      }
    } catch (err: any) {
      console.error("SFTP remote poll error:", err);
    } finally {
      this.isSyncing = false;
    }
  }

  // ---- Full sync (manual / startup / interval) ----

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

    try {
      const vaultPath = (this.app.vault.adapter as any).getBasePath();
      const prevRecords = await this.syncState.load();
      const direction = this.settings.syncDirection;
      const ignore = this.settings.ignorePaths;

      // First sync or simple direction: use single rsync call (fast!)
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
      this.isSyncing = false;
    }
  }

  /**
   * Bulk sync using a single rsync call. Used for:
   * - First sync (no previous records)
   * - pull_only / push_only modes
   */
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
      // bidirectional first sync: use incremental (3-way) to avoid
      // pull→push creating duplicate nested folders
      const remoteFiles = await listRemoteFiles(this.settings, ignorePatterns);
      const localFiles = this.collectLocalFiles(vaultPath);
      const plan = buildSyncPlan({
        localFiles,
        remoteFiles,
        prevRecords: new Map(),
        settings: this.settings,
      });

      const toDownload = plan.filter((e) => e.decision === "download").map((e) => e.path);
      const toUpload = plan.filter((e) => e.decision === "upload").map((e) => e.path);

      for (const f of toDownload) {
        this.markAsPulled(f);
        await rsyncPullFile(this.settings, vaultPath, f);
      }
      for (const f of toUpload) {
        await rsyncPushFile(this.settings, vaultPath, f);
      }
      new Notice(`SFTP: Initial sync complete (↓${toDownload.length} ↑${toUpload.length})`);
    }

    // Rebuild sync records from current local state
    await this.rebuildSyncRecords(vaultPath);
  }

  /**
   * Incremental sync using 3-way comparison. Used for subsequent
   * bidirectional syncs where we need conflict detection.
   */
  private async runIncrementalSync(
    vaultPath: string,
    prevRecords: Map<string, SyncRecord>,
    ignorePatterns: string[]
  ): Promise<void> {
    const remoteFiles = await listRemoteFiles(this.settings, ignorePatterns);
    const localFiles = this.collectLocalFiles(vaultPath);

    const plan = buildSyncPlan({
      localFiles,
      remoteFiles,
      prevRecords,
      settings: this.settings,
    });

    const toDownload = plan.filter((e) => e.decision === "download").map((e) => e.path);
    const toUpload = plan.filter((e) => e.decision === "upload").map((e) => e.path);
    const toDeleteLocal = plan.filter((e) => e.decision === "delete_local");
    const toDeleteRemote = plan.filter((e) => e.decision === "delete_remote");

    let syncedCount = 0;

    // Download changed files
    for (const f of toDownload) {
      this.markAsPulled(f);
      await rsyncPullFile(this.settings, vaultPath, f);
      syncedCount++;
    }

    // Upload changed files
    for (const f of toUpload) {
      await rsyncPushFile(this.settings, vaultPath, f);
      syncedCount++;
    }

    // Delete local files
    for (const entity of toDeleteLocal) {
      const localFull = path.join(vaultPath, entity.path);
      if (fs.existsSync(localFull)) {
        fs.unlinkSync(localFull);
        syncedCount++;
      }
    }

    // Delete remote files (properly escaped)
    if (toDeleteRemote.length > 0) {
      await deleteRemoteFiles(
        this.settings,
        toDeleteRemote.map((e) => e.path)
      );
      syncedCount += toDeleteRemote.length;
    }

    // Update sync records
    await this.rebuildSyncRecords(vaultPath);

    if (syncedCount > 0) {
      new Notice(`SFTP: Synced ${syncedCount} file(s)`);
    }
  }

  /**
   * Rebuild sync records from current local file state.
   */
  private async rebuildSyncRecords(vaultPath: string): Promise<void> {
    const localFiles = this.collectLocalFiles(vaultPath);
    const records = new Map<string, SyncRecord>();
    for (const f of localFiles) {
      records.set(f.path, { path: f.path, mtime: f.mtime, size: f.size });
    }
    await this.syncState.save(records);
  }

  // ---- Local file collection ----

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
      const fullPath = path.join(basePath, entry.name);
      const relPath =
        basePath === base
          ? entry.name
          : `${path.relative(base, basePath)}/${entry.name}`;

      if (shouldIgnore(relPath, this.settings.ignorePaths)) continue;

      if (entry.isDirectory()) {
        const subFiles = this.collectLocalFiles(fullPath, base);
        results.push(...subFiles);
      } else if (entry.isFile()) {
        const stats = fs.statSync(fullPath);
        results.push({
          path: relPath,
          size: stats.size,
          mtime: stats.mtimeMs,
          isDirectory: false,
        });
      }
    }

    return results;
  }

  // ---- Status bar ----

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
      case "ready":
      default:
        this.statusBarItem.setText("SFTP: Ready");
        break;
    }
  }
}
