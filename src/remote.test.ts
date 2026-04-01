import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "./types";
import type { SftpSyncSettings } from "./types";

// Mock child_process - all SSH and rsync calls go through execFile
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { sshExec, testSshConnection, listRemoteFiles } from "./remote";
import { execFile } from "child_process";

function settings(overrides: Partial<SftpSyncSettings> = {}): SftpSyncSettings {
  return { ...DEFAULT_SETTINGS, host: "myhost", port: 22, username: "user", ...overrides };
}

function mockExecFileSuccess(stdout: string) {
  (execFile as any).mockImplementation(
    (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, stdout, "")
  );
}

function mockExecFileError(message: string) {
  (execFile as any).mockImplementation(
    (_cmd: string, _args: string[], _opts: any, cb: Function) =>
      cb(new Error(message), "", message)
  );
}

describe("sshExec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should execute command via ssh binary and return stdout", async () => {
    mockExecFileSuccess("hello\n");

    const result = await sshExec(settings(), "echo hello");
    expect(result).toBe("hello\n");
    expect(execFile).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["-p", "22", "user@myhost", "echo hello"]),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("should reject on connection error", async () => {
    mockExecFileError("Connection refused");
    await expect(sshExec(settings(), "test")).rejects.toThrow("Connection refused");
  });

  it("should include private key path in args", async () => {
    mockExecFileSuccess("ok");
    await sshExec(settings({ privateKeyPath: "/path/to/key" }), "echo ok");
    expect(execFile).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["-i", "/path/to/key"]),
      expect.any(Object),
      expect.any(Function)
    );
  });
});

describe("testSshConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return ok:true on success", async () => {
    mockExecFileSuccess("ok\n");
    const result = await testSshConnection(settings());
    expect(result.ok).toBe(true);
  });

  it("should return ok:false on failure", async () => {
    mockExecFileError("Timeout");
    const result = await testSshConnection(settings());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Timeout");
  });
});

describe("listRemoteFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should parse find output into FileInfo array", async () => {
    const findOutput = [
      "1700000000.000000 1024 src/main.ts",
      "1700001000.500000 2048 README.md",
      "",
    ].join("\n");

    mockExecFileSuccess(findOutput);

    const s = settings({ remotePath: "/remote/path" });
    const files = await listRemoteFiles(s, [".git", "node_modules", "*.pyc"]);

    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({
      path: "src/main.ts",
      size: 1024,
      mtime: 1700000000000,
      isDirectory: false,
    });
    expect(files[1]).toEqual({
      path: "README.md",
      size: 2048,
      mtime: 1700001000500,
      isDirectory: false,
    });
  });

  it("should handle empty output", async () => {
    mockExecFileSuccess("");
    const files = await listRemoteFiles(settings({ remotePath: "/remote" }), []);
    expect(files).toHaveLength(0);
  });

  it("should skip paths containing ..", async () => {
    mockExecFileSuccess("1700000000.0 100 ../../etc/passwd\n1700000000.0 200 safe.md\n");
    const files = await listRemoteFiles(settings({ remotePath: "/remote" }), []);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("safe.md");
  });
});

describe("rsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rsyncPull should call execFile with correct args", async () => {
    const { rsyncPull } = await import("./remote");
    mockExecFileSuccess("");

    await rsyncPull(
      settings({ privateKeyPath: "/key", remotePath: "/remote" }),
      "/local"
    );

    expect(execFile).toHaveBeenCalledWith(
      "rsync",
      expect.arrayContaining(["-az"]),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("rsyncPush should call execFile with correct args", async () => {
    const { rsyncPush } = await import("./remote");
    mockExecFileSuccess("");

    await rsyncPush(
      settings({ privateKeyPath: "/key", remotePath: "/remote" }),
      "/local"
    );

    expect(execFile).toHaveBeenCalledWith(
      "rsync",
      expect.arrayContaining(["-az"]),
      expect.any(Object),
      expect.any(Function)
    );
  });
});
