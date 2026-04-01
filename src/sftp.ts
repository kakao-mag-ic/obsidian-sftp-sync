import SftpClient from "ssh2-sftp-client";
import type { SftpSyncSettings, FileInfo } from "./types";
import { shouldIgnore } from "./ignore";
import * as fs from "fs";

export class SftpConnection {
  private client: SftpClient;
  private settings: SftpSyncSettings;
  private connected = false;

  constructor(settings: SftpSyncSettings) {
    this.settings = settings;
    this.client = new SftpClient();
  }

  buildConnectConfig(): SftpClient.ConnectOptions {
    const config: SftpClient.ConnectOptions = {
      host: this.settings.host,
      port: this.settings.port,
      username: this.settings.username,
      readyTimeout: this.settings.connectTimeoutMs,
    };

    if (this.settings.privateKey) {
      try {
        config.privateKey = Buffer.from(this.settings.privateKey, "base64").toString("utf-8");
      } catch {
        config.privateKey = this.settings.privateKey;
      }
    } else if (this.settings.privateKeyPath) {
      config.privateKey = fs.readFileSync(this.settings.privateKeyPath, "utf-8");
    }

    if (this.settings.passphrase) {
      config.passphrase = this.settings.passphrase;
    }

    return config;
  }

  async connect(): Promise<boolean> {
    try {
      const config = this.buildConnectConfig();
      await this.client.connect(config);
      this.connected = true;
      return true;
    } catch (err) {
      this.connected = false;
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      try {
        await this.client.end();
      } catch {
        // ignore disconnect errors
      }
      this.connected = false;
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const config = this.buildConnectConfig();
      await this.client.connect(config);
      this.connected = true;
      await this.disconnect();
      return { ok: true, message: "Success: connected to server" };
    } catch (err: any) {
      this.connected = false;
      try { await this.client.end(); } catch { /* ignore */ }
      return { ok: false, message: err?.message || "Unknown error" };
    }
  }

  /**
   * List files in a single directory (non-recursive).
   */
  async list(remotePath: string): Promise<FileInfo[]> {
    const entries = await this.client.list(remotePath);
    return entries.map((entry) => ({
      path: entry.name,
      size: entry.size,
      mtime: entry.modifyTime,
      isDirectory: entry.type === "d",
    }));
  }

  /**
   * Recursively list all files under remotePath.
   * Returns only files (not directories), with paths relative to remotePath.
   */
  async listRecursive(remotePath: string, relativeTo?: string, ignorePatterns?: string[]): Promise<FileInfo[]> {
    const base = relativeTo ?? remotePath;
    const entries = await this.list(remotePath);
    const results: FileInfo[] = [];

    for (const entry of entries) {
      const fullPath = remotePath === base
        ? entry.path
        : `${remotePath.slice(base.length + 1)}/${entry.path}`;

      // Skip ignored paths early to avoid unnecessary recursion
      if (ignorePatterns && shouldIgnore(fullPath, ignorePatterns)) {
        continue;
      }

      if (entry.isDirectory) {
        const subFiles = await this.listRecursive(`${remotePath}/${entry.path}`, base, ignorePatterns);
        results.push(...subFiles);
      } else {
        results.push({
          ...entry,
          path: fullPath,
        });
      }
    }

    return results;
  }

  async stat(remotePath: string): Promise<FileInfo | null> {
    try {
      const stats = await this.client.stat(remotePath);
      const name = remotePath.split("/").pop() || remotePath;
      return {
        path: name,
        size: stats.size,
        mtime: stats.modifyTime,
        isDirectory: stats.isDirectory,
      };
    } catch {
      return null;
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    await this.client.get(remotePath, localPath);
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    await this.client.put(localPath, remotePath);
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.client.mkdir(remotePath, true);
  }

  async delete(remotePath: string): Promise<void> {
    await this.client.delete(remotePath);
  }

  async exists(remotePath: string): Promise<boolean> {
    const result = await this.client.exists(remotePath);
    return result !== false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
