import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { SftpSyncSettings, FileInfo } from "./types";

const SSH_COMMAND_TIMEOUT_MS = 60000;

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function validateRelativePath(relativePath: string): void {
  if (relativePath.includes("..")) {
    throw new Error(`Refusing to sync path with '..' segments: ${relativePath}`);
  }
  if (relativePath.startsWith("/")) {
    throw new Error(`Refusing to sync absolute path: ${relativePath}`);
  }
}

function buildSshArgs(settings: SftpSyncSettings): string[] {
  const args = ["-p", String(settings.port)];
  if (settings.privateKeyPath) {
    args.push("-i", settings.privateKeyPath);
  }
  if (!settings.strictHostKeyChecking) {
    args.push("-o", "StrictHostKeyChecking=no");
  }
  args.push("-o", `ConnectTimeout=${Math.ceil(settings.connectTimeoutMs / 1000)}`);
  args.push(`${settings.username}@${settings.host}`);
  return args;
}

export function sshExec(settings: SftpSyncSettings, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [...buildSshArgs(settings), command];
    execFile("ssh", args, {
      timeout: SSH_COMMAND_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

export async function testSshConnection(settings: SftpSyncSettings): Promise<{ ok: boolean; message: string }> {
  try {
    await sshExec(settings, "echo ok");
    return { ok: true, message: "Success: connected to server" };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Unknown error" };
  }
}

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
    return `find -P ${escaped} -type f ${extPrunes} ${extraFlags} -printf '%T@ %s %P\\n'`;
  }

  const pruneArgs = dirPatterns
    .map((p) => {
      const name = p.endsWith("/") ? p.slice(0, -1) : p;
      return `-name ${shellEscape(name)} -prune`;
    })
    .join(" -o ");

  return `find -P ${escaped} \\( ${pruneArgs} \\) -o -type f ${extPrunes} ${extraFlags} -printf '%T@ %s %P\\n'`;
}

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

export async function listRemoteFiles(
  settings: SftpSyncSettings,
  ignorePatterns: string[]
): Promise<FileInfo[]> {
  const cmd = buildFindCommand(settings.remotePath, ignorePatterns, "");
  const output = await sshExec(settings, cmd);
  return parseFindOutput(output);
}

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

// ---- rsync helpers ----

function buildRsyncSshArg(settings: SftpSyncSettings): string {
  const parts = ["ssh", "-p", String(settings.port)];
  if (settings.privateKeyPath) {
    parts.push("-i", shellEscape(settings.privateKeyPath));
  }
  if (!settings.strictHostKeyChecking) {
    parts.push("-o", "StrictHostKeyChecking=no");
  }
  parts.push("-o", `ConnectTimeout=${Math.ceil(settings.connectTimeoutMs / 1000)}`);
  return parts.join(" ");
}

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
 * Rsync full directory. direction: "pull" or "push".
 */
export function rsyncBulk(
  settings: SftpSyncSettings,
  localPath: string,
  direction: "pull" | "push",
  ignorePatterns?: string[],
  deleteSync?: boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sshArg = buildRsyncSshArg(settings);
    const remote = `${settings.username}@${settings.host}:${settings.remotePath}/`;
    const local = localPath.endsWith("/") ? localPath : `${localPath}/`;

    const args = ["-az", "-e", sshArg, ...buildFilterArgs(settings, ignorePatterns ?? [])];
    if (deleteSync) args.push("--delete-after");

    if (direction === "pull") {
      args.push(remote, local);
    } else {
      args.push(local, remote);
    }

    execFile("rsync", args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Keep old names as aliases for compatibility
export function rsyncPull(
  settings: SftpSyncSettings, localPath: string,
  ignorePatterns?: string[], deleteSync?: boolean
): Promise<string> {
  return rsyncBulk(settings, localPath, "pull", ignorePatterns, deleteSync);
}

export function rsyncPush(
  settings: SftpSyncSettings, localPath: string,
  ignorePatterns?: string[], deleteSync?: boolean
): Promise<string> {
  return rsyncBulk(settings, localPath, "push", ignorePatterns, deleteSync);
}

/**
 * Rsync multiple files at once using --files-from.
 * This is the key performance optimization: 1 rsync call instead of N.
 */
export function rsyncFiles(
  settings: SftpSyncSettings,
  localPath: string,
  relativePaths: string[],
  direction: "pull" | "push"
): Promise<string> {
  if (relativePaths.length === 0) return Promise.resolve("");

  // Validate all paths
  for (const p of relativePaths) validateRelativePath(p);

  return new Promise((resolve, reject) => {
    // Write file list to temp file
    const tmpFile = path.join(os.tmpdir(), `sftp-sync-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, relativePaths.join("\n") + "\n");

    const sshArg = buildRsyncSshArg(settings);
    const remote = `${settings.username}@${settings.host}:${settings.remotePath}/`;
    const local = localPath.endsWith("/") ? localPath : `${localPath}/`;

    const args = ["-az", "-e", sshArg, "--files-from", tmpFile];
    if (settings.maxFileSizeMB > 0) {
      args.push("--max-size", `${settings.maxFileSizeMB}m`);
    }

    if (direction === "pull") {
      args.push(remote, local);
    } else {
      args.push(local, remote);
    }

    execFile("rsync", args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Single file operations — kept for file watcher (small batches)
export function rsyncPushFile(
  settings: SftpSyncSettings, localPath: string, relativePath: string
): Promise<string> {
  return rsyncFiles(settings, localPath, [relativePath], "push");
}

export function rsyncPullFile(
  settings: SftpSyncSettings, localPath: string, relativePath: string
): Promise<string> {
  return rsyncFiles(settings, localPath, [relativePath], "pull");
}
