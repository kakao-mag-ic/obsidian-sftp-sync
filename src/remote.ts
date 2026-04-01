import { Client } from "ssh2";
import { execFile } from "child_process";
import * as fs from "fs";
import type { SftpSyncSettings, FileInfo } from "./types";

const SSH_COMMAND_TIMEOUT_MS = 30000;

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
 * Includes a command execution timeout (not just connection timeout).
 */
export function sshExec(settings: SftpSyncSettings, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let done = false;

    const timeoutId = setTimeout(() => {
      if (!done) {
        done = true;
        try { conn.end(); } catch { /* ignore */ }
        reject(new Error(`SSH command timed out after ${SSH_COMMAND_TIMEOUT_MS}ms`));
      }
    }, SSH_COMMAND_TIMEOUT_MS);

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutId);
      try { conn.end(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(stdout);
    };

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) return finish(err);
        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on("close", () => finish());
      });
    });

    conn.on("error", (err) => finish(err));
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
 * Uses -P (physical) to avoid following symlinks.
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
 * List remote files changed since a given timestamp.
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
 * privateKeyPath is properly escaped.
 */
function buildRsyncSshArg(settings: SftpSyncSettings): string {
  let sshCmd = `ssh -p ${settings.port}`;
  if (settings.privateKeyPath) {
    sshCmd += ` -i ${shellEscape(settings.privateKeyPath)}`;
  }
  if (!settings.strictHostKeyChecking) {
    sshCmd += " -o StrictHostKeyChecking=no";
  }
  return sshCmd;
}

/**
 * Build common rsync args: --exclude, --max-size, --protect-args, --no-links.
 */
function buildFilterArgs(settings: SftpSyncSettings, ignorePatterns: string[]): string[] {
  const args: string[] = [
    "--protect-args",  // safely handle spaces/unicode in remote paths
    "--no-links",      // skip symlinks to prevent path traversal
  ];
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
      "-az", "--relative", "--protect-args", "--no-links",
      "-e", sshArg,
    ];
    if (settings.maxFileSizeMB > 0) {
      args.push("--max-size", `${settings.maxFileSizeMB}m`);
    }
    args.push(`./${relativePath}`, remote);

    execFile("rsync", args, { cwd: localPath, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

/**
 * Rsync a single file from remote to local.
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

    const args = ["-az", "--protect-args", "--no-links", "-e", sshArg];
    if (settings.maxFileSizeMB > 0) {
      args.push("--max-size", `${settings.maxFileSizeMB}m`);
    }
    args.push(remoteFile, localFile);

    execFile("rsync", args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}
