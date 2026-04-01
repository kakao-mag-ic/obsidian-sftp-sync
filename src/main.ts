import { Notice, Plugin } from "obsidian";
import type { SftpSyncSettings, SyncStatus, FileInfo, SyncRecord } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { SftpConnection } from "./sftp";
import { SftpSyncSettingTab } from "./settings";
import { SyncState } from "./state";
import { buildSyncPlan } from "./sync";
import { shouldIgnore } from "./ignore";
import * as path from "path";
import * as fs from "fs";

export default class SftpSyncPlugin extends Plugin {
  settings: SftpSyncSettings = DEFAULT_SETTINGS;
  syncState: SyncState = new SyncState();
  autoSyncTimer: number | null = null;
  isSyncing = false;
  statusBarItem: HTMLElement | null = null;

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
      callback: () => this.runSync(),
    });

    this.addCommand({
      id: "sftp-sync-test",
      name: "Test connection",
      callback: () => this.testConnection(),
    });

    // Ribbon icon
    this.addRibbonIcon("refresh-cw", "SFTP Sync", () => this.runSync());

    // Startup sync
    if (this.settings.syncOnStartup) {
      setTimeout(() => this.runSync(), 5000);
    }

    // Auto sync
    this.startAutoSync();
  }

  async onunload(): Promise<void> {
    this.stopAutoSync();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  startAutoSync(): void {
    this.stopAutoSync();
    if (this.settings.autoSyncIntervalSec > 0) {
      this.autoSyncTimer = window.setInterval(
        () => this.runSync(),
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

  async testConnection(): Promise<void> {
    const conn = new SftpConnection(this.settings);
    const result = await conn.testConnection();
    new Notice(result.ok ? "SFTP: Connection successful!" : `SFTP: ${result.message}`);
  }

  async runSync(): Promise<void> {
    if (this.isSyncing) {
      new Notice("SFTP: Sync already in progress");
      return;
    }

    this.isSyncing = true;
    this.updateStatusBar("syncing");

    const conn = new SftpConnection(this.settings);
    let retries = 0;

    while (retries <= this.settings.maxRetries) {
      const connected = await conn.connect();
      if (connected) break;
      retries++;
      if (retries > this.settings.maxRetries) {
        this.updateStatusBar("offline");
        this.isSyncing = false;
        new Notice("SFTP: Could not connect to server");
        return;
      }
    }

    try {
      // Collect remote files (pass ignore patterns to skip .git etc during traversal)
      const filteredRemote = await conn.listRecursive(
        this.settings.remotePath,
        undefined,
        this.settings.ignorePaths
      );

      // Collect local files
      const vaultPath = (this.app.vault.adapter as any).getBasePath();
      const localFiles = this.collectLocalFiles(vaultPath);
      const filteredLocal = localFiles.filter(
        (f) => !shouldIgnore(f.path, this.settings.ignorePaths)
      );

      // Load previous sync records
      const prevRecords = await this.syncState.load();

      // Build sync plan
      const plan = buildSyncPlan({
        localFiles: filteredLocal,
        remoteFiles: filteredRemote,
        prevRecords,
        settings: this.settings,
      });

      // Execute plan
      let syncedCount = 0;
      for (const entity of plan) {
        if (entity.decision === "download" && entity.remote) {
          const remoteFull = `${this.settings.remotePath}/${entity.path}`;
          const localFull = path.join(vaultPath, entity.path);

          // Ensure parent directory exists
          const dir = path.dirname(localFull);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }

          await conn.download(remoteFull, localFull);
          syncedCount++;
        } else if (entity.decision === "upload" && entity.local) {
          const remoteFull = `${this.settings.remotePath}/${entity.path}`;
          const localFull = path.join(vaultPath, entity.path);

          // Ensure remote parent directory exists
          const remoteDir = remoteFull.substring(0, remoteFull.lastIndexOf("/"));
          if (!(await conn.exists(remoteDir))) {
            await conn.mkdir(remoteDir);
          }

          await conn.upload(localFull, remoteFull);
          syncedCount++;
        } else if (entity.decision === "delete_local") {
          const localFull = path.join(vaultPath, entity.path);
          if (fs.existsSync(localFull)) {
            fs.unlinkSync(localFull);
            syncedCount++;
          }
        } else if (entity.decision === "delete_remote") {
          const remoteFull = `${this.settings.remotePath}/${entity.path}`;
          await conn.delete(remoteFull);
          syncedCount++;
        }
      }

      // Update sync records for successfully synced files
      for (const entity of plan) {
        if (entity.decision === "skip") continue;

        if (entity.decision === "delete_local" || entity.decision === "delete_remote") {
          await this.syncState.deleteRecord(entity.path);
        } else {
          // After download/upload, record the current state
          const file = entity.decision === "download" ? entity.remote : entity.local;
          if (file) {
            await this.syncState.setRecord(entity.path, {
              path: entity.path,
              mtime: file.mtime,
              size: file.size,
            });
          }
        }
      }

      await conn.disconnect();
      this.updateStatusBar("success");
      if (syncedCount > 0) {
        new Notice(`SFTP: Synced ${syncedCount} file(s)`);
      }
    } catch (err: any) {
      console.error("SFTP sync error:", err);
      this.updateStatusBar("failed");
      new Notice(`SFTP: Sync failed - ${err?.message || "Unknown error"}`);
      try {
        await conn.disconnect();
      } catch {
        /* ignore */
      }
    } finally {
      this.isSyncing = false;
    }
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
      const fullPath = path.join(basePath, entry.name);
      const relPath =
        basePath === base
          ? entry.name
          : `${path.relative(base, basePath)}/${entry.name}`;

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
