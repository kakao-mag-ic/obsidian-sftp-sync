import { Client } from "ssh2";
import { execFile } from "child_process";
import * as fs from "fs";
import type { SftpSyncSettings, FileInfo } from "./types";

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
 * List all files under remotePath using `find` command via SSH.
 * Returns FileInfo[] with paths relative to remotePath.
 */
export async function listRemoteFiles(
  settings: SftpSyncSettings,
  ignorePatterns: string[]
): Promise<FileInfo[]> {
  // Build find command with prune for ignored directories
  const pruneArgs = ignorePatterns
    .filter((p) => !p.startsWith("*")) // directory patterns only
    .map((p) => {
      const name = p.endsWith("/") ? p.slice(0, -1) : p;
      return `-name '${name}' -prune`;
    })
    .join(" -o ");

  const extPrunes = ignorePatterns
    .filter((p) => p.startsWith("*."))
    .map((p) => `! -name '${p}'`)
    .join(" ");

  // find command: prune ignored dirs, print files with stat info
  // Output format: <mtime_epoch> <size> <relative_path>
  const remotePath = settings.remotePath;
  const cmd = `find '${remotePath}' \\( ${pruneArgs} \\) -o -type f ${extPrunes} -printf '%T@ %s %P\\n'`;

  const output = await sshExec(settings, cmd);
  const files: FileInfo[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;

    // Parse: "1234567890.123456 1024 path/to/file.md"
    const firstSpace = line.indexOf(" ");
    const secondSpace = line.indexOf(" ", firstSpace + 1);
    if (firstSpace === -1 || secondSpace === -1) continue;

    const mtimeSec = parseFloat(line.slice(0, firstSpace));
    const size = parseInt(line.slice(firstSpace + 1, secondSpace));
    const filePath = line.slice(secondSpace + 1);

    if (!filePath) continue;

    files.push({
      path: filePath,
      mtime: Math.floor(mtimeSec * 1000), // convert to ms
      size,
      isDirectory: false,
    });
  }

  return files;
}

/**
 * List remote files changed since a given timestamp using `find -newer`.
 */
export async function listRemoteChangedFiles(
  settings: SftpSyncSettings,
  sinceMsTimestamp: number,
  ignorePatterns: string[]
): Promise<FileInfo[]> {
  const remotePath = settings.remotePath;
  const sinceSeconds = Math.floor(sinceMsTimestamp / 1000);

  const pruneArgs = ignorePatterns
    .filter((p) => !p.startsWith("*"))
    .map((p) => {
      const name = p.endsWith("/") ? p.slice(0, -1) : p;
      return `-name '${name}' -prune`;
    })
    .join(" -o ");

  const extPrunes = ignorePatterns
    .filter((p) => p.startsWith("*."))
    .map((p) => `! -name '${p}'`)
    .join(" ");

  // Use -newermt with epoch timestamp
  const cmd = `find '${remotePath}' \\( ${pruneArgs} \\) -o -type f ${extPrunes} -newermt @${sinceSeconds} -printf '%T@ %s %P\\n'`;

  const output = await sshExec(settings, cmd);
  const files: FileInfo[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;

    const firstSpace = line.indexOf(" ");
    const secondSpace = line.indexOf(" ", firstSpace + 1);
    if (firstSpace === -1 || secondSpace === -1) continue;

    const mtimeSec = parseFloat(line.slice(0, firstSpace));
    const size = parseInt(line.slice(firstSpace + 1, secondSpace));
    const filePath = line.slice(secondSpace + 1);

    if (!filePath) continue;

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
 * Build rsync SSH command args.
 */
function buildRsyncSshArg(settings: SftpSyncSettings): string {
  let sshCmd = `ssh -p ${settings.port}`;
  if (settings.privateKeyPath) {
    sshCmd += ` -i '${settings.privateKeyPath}'`;
  }
  sshCmd += " -o StrictHostKeyChecking=no";
  return sshCmd;
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
  ignorePatterns?: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sshArg = buildRsyncSshArg(settings);
    const remote = `${settings.username}@${settings.host}:${settings.remotePath}/`;
    const local = localPath.endsWith("/") ? localPath : `${localPath}/`;

    const args = [
      "-az",
      "-e", sshArg,
      ...buildFilterArgs(settings, ignorePatterns ?? []),
      remote, local,
    ];

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
  ignorePatterns?: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sshArg = buildRsyncSshArg(settings);
    const remote = `${settings.username}@${settings.host}:${settings.remotePath}/`;
    const local = localPath.endsWith("/") ? localPath : `${localPath}/`;

    const args = [
      "-az",
      "-e", sshArg,
      ...buildFilterArgs(settings, ignorePatterns ?? []),
      local, remote,
    ];

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
  return new Promise((resolve, reject) => {
    const sshArg = buildRsyncSshArg(settings);
    const remote = `${settings.username}@${settings.host}:${settings.remotePath}/`;
    // Use --relative with ./ marker: cd to localPath, sync ./relativePath
    // This ensures the file ends up at remotePath/relativePath (not remotePath/relativePath/filename)
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
  return new Promise((resolve, reject) => {
    const sshArg = buildRsyncSshArg(settings);
    const remoteFile = `${settings.username}@${settings.host}:${settings.remotePath}/${relativePath}`;

    // Determine the local parent directory for this file
    const localFile = `${localPath}/${relativePath}`;
    const localDir = localFile.substring(0, localFile.lastIndexOf("/"));
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    // rsync remote file → exact local file path
    const args = ["-az", "-e", sshArg, remoteFile, localFile];

    execFile("rsync", args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}
