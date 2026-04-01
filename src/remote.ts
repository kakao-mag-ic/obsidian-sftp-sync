import { Client } from "ssh2";
import { execFile } from "child_process";
import * as fs from "fs";
import type { SftpSyncSettings, FileInfo } from "./types";

/**
 * Escape a string for safe use inside single quotes in shell commands.
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Validate that a relative path doesn't escape its base directory.
 */
function validateRelativePath(relativePath: string): void {
  if (relativePath.includes("..")) {
    throw new Error(`Refusing to sync path with '..' segments: ${relativePath}`);
  }
  if (relativePath.startsWith("/")) {
    throw new Error(`Refusing to sync absolute path: ${relativePath}`);
  }
}

/**
 * Build SSH connection config from settings.
 */
function buildSshConfig(settings: SftpSyncSettings) {
  const config: any = {
    host: settings.host,
    port: settings.port,
    username: settings.username,
    readyTimeout: settings.connectTimeoutMs,
  };

  if (settings.privateKey) {
    try {
      config.privateKey = Buffer.from(settings.privateKey, "base64").toString("utf-8");
    } catch {
      config.privateKey = settings.privateKey;
    }
  } else if (settings.privateKeyPath) {
    config.privateKey = fs.readFileSync(settings.privateKeyPath, "utf-8");
  }

  if (settings.passphrase) {
    config.passphrase = settings.passphrase;
  }

  return config;
}

/**
 * Execute a command on the remote server via SSH and return stdout.
 */
export function sshExec(settings: SftpSyncSettings, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on("close", () => {
          conn.end();
          resolve(stdout);
        });
      });
    });

    conn.on("error", (err) => reject(err));
    conn.connect(buildSshConfig(settings));
  });
}

/**
 * Test SSH connection.
 */
export async function testSshConnection(settings: SftpSyncSettings): Promise<{ ok: boolean; message: string }> {
  try {
    await sshExec(settings, "echo ok");
    return { ok: true, message: "Success: connected to server" };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Unknown error" };
  }
}

/**
 * Build the find command for listing remote files.
 * Handles empty ignore patterns gracefully.
 */
function buildFindCommand(
  remotePath: string,
  ignorePatterns: string[],
  extraFlags: string
): string {
  const dirPatterns = ignorePatterns.filter((p) => !p.startsWith("*"));
  const extPatterns = ignorePatterns.filter((p) => p.startsWith("*."));

  const extPrunes = extPatterns
    .map((p) => `! -name ${shellEscape(p)}`)
    .join(" ");

  const escaped = shellEscape(remotePath);

  if (dirPatterns.length === 0) {
    // No directory prune needed
    return `find ${escaped} -type f ${extPrunes} ${extraFlags} -printf '%T@ %s %P\\n'`;
  }

  const pruneArgs = dirPatterns
    .map((p) => {
      const name = p.endsWith("/") ? p.slice(0, -1) : p;
      return `-name ${shellEscape(name)} -prune`;
    })
    .join(" -o ");

  return `find ${escaped} \\( ${pruneArgs} \\) -o -type f ${extPrunes} ${extraFlags} -printf '%T@ %s %P\\n'`;
}

/**
 * Parse find output into FileInfo array.
 */
function parseFindOutput(output: string): FileInfo[] {
  const files: FileInfo[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;

    const firstSpace = line.indexOf(" ");
    const secondSpace = line.indexOf(" ", firstSpace + 1);
    if (firstSpace === -1 || secondSpace === -1) continue;

    const mtimeSec = parseFloat(line.slice(0, firstSpace));
    const size = parseInt(line.slice(firstSpace + 1, secondSpace));
    const filePath = line.slice(secondSpace + 1);

    if (!filePath || filePath.includes("..")) continue;

    files.push({
      path: filePath,
      mtime: Math.floor(mtimeSec * 1000),
      size,
      isDirectory: false,
    });
  }

  return files;
}

/**
 * List all files under remotePath using `find` command via SSH.
 * Returns FileInfo[] with paths relative to remotePath.
 */
export async function listRemoteFiles(
  settings: SftpSyncSettings,
  ignorePatterns: string[]
): Promise<FileInfo[]> {
  const cmd = buildFindCommand(settings.remotePath, ignorePatterns, "");
  const output = await sshExec(settings, cmd);
  return parseFindOutput(output);
}

/**
 * List remote files changed since a given timestamp using `find -newermt`.
 */
export async function listRemoteChangedFiles(
  settings: SftpSyncSettings,
  sinceMsTimestamp: number,
  ignorePatterns: string[]
): Promise<FileInfo[]> {
  const sinceSeconds = Math.floor(sinceMsTimestamp / 1000);
  const cmd = buildFindCommand(
    settings.remotePath,
    ignorePatterns,
    `-newermt @${sinceSeconds}`
  );
  const output = await sshExec(settings, cmd);
  return parseFindOutput(output);
}

/**
 * Delete remote files via SSH. Paths are properly escaped.
 */
export async function deleteRemoteFiles(
  settings: SftpSyncSettings,
  relativePaths: string[]
): Promise<void> {
  if (relativePaths.length === 0) return;
  const escaped = relativePaths
    .map((p) => {
      validateRelativePath(p);
      return shellEscape(`${settings.remotePath}/${p}`);
    })
    .join(" ");
  await sshExec(settings, `rm -f ${escaped}`);
}

/**
 * Build rsync SSH command args.
 */
function buildRsyncSshArg(settings: SftpSyncSettings): string {
  const parts = ["ssh", "-p", String(settings.port)];
  if (settings.privateKeyPath) {
    parts.push("-i", settings.privateKeyPath);
  }
  parts.push("-o", "StrictHostKeyChecking=no");
  return parts.join(" ");
}

/**
 * Build common rsync args: --exclude patterns and --max-size.
 */
function buildFilterArgs(settings: SftpSyncSettings, ignorePatterns: string[]): string[] {
  const args: string[] = [];
  for (const p of ignorePatterns) {
    const pattern = p.endsWith("/") ? p.slice(0, -1) : p;
    args.push("--exclude", pattern);
  }
  if (settings.maxFileSizeMB > 0) {
    args.push("--max-size", `${settings.maxFileSizeMB}m`);
  }
  return args;
}

/**
 * Rsync full directory from remote to local.
 * Single rsync call — fast for first sync and bulk operations.
 */
export function rsyncPull(
  settings: SftpSyncSettings,
  localPath: string,
  ignorePatterns?: string[],
  deleteSync?: boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sshArg = buildRsyncSshArg(settings);
    const remote = `${settings.username}@${settings.host}:${settings.remotePath}/`;
    const local = localPath.endsWith("/") ? localPath : `${localPath}/`;

    const args = [
      "-az",
      "-e", sshArg,
      ...buildFilterArgs(settings, ignorePatterns ?? []),
    ];
    if (deleteSync) {
      args.push("--delete-after");
    }
    args.push(remote, local);

    execFile("rsync", args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

/**
 * Rsync full directory from local to remote.
 * Single rsync call — fast for bulk push.
 */
export function rsyncPush(
  settings: SftpSyncSettings,
  localPath: string,
  ignorePatterns?: string[],
  deleteSync?: boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sshArg = buildRsyncSshArg(settings);
    const remote = `${settings.username}@${settings.host}:${settings.remotePath}/`;
    const local = localPath.endsWith("/") ? localPath : `${localPath}/`;

    const args = [
      "-az",
      "-e", sshArg,
      ...buildFilterArgs(settings, ignorePatterns ?? []),
    ];
    if (deleteSync) {
      args.push("--delete-after");
    }
    args.push(local, remote);

    execFile("rsync", args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

/**
 * Rsync a single file from local to remote.
 * Uses --relative to preserve directory structure without nesting.
 */
export function rsyncPushFile(
  settings: SftpSyncSettings,
  localPath: string,
  relativePath: string
): Promise<string> {
  validateRelativePath(relativePath);
  return new Promise((resolve, reject) => {
    const sshArg = buildRsyncSshArg(settings);
    const remote = `${settings.username}@${settings.host}:${settings.remotePath}/`;
    const args = [
      "-az", "--relative",
      "-e", sshArg,
      `./${relativePath}`,
      remote,
    ];

    execFile("rsync", args, { cwd: localPath, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

/**
 * Rsync a single file from remote to local.
 * Downloads to the correct relative path under localPath.
 */
export function rsyncPullFile(
  settings: SftpSyncSettings,
  localPath: string,
  relativePath: string
): Promise<string> {
  validateRelativePath(relativePath);
  return new Promise((resolve, reject) => {
    const sshArg = buildRsyncSshArg(settings);
    const remoteFile = `${settings.username}@${settings.host}:${settings.remotePath}/${relativePath}`;

    const localFile = `${localPath}/${relativePath}`;
    const localDir = localFile.substring(0, localFile.lastIndexOf("/"));
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    const args = ["-az", "-e", sshArg, remoteFile, localFile];

    execFile("rsync", args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}
