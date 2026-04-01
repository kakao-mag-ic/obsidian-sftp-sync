import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "./types";
import type { SftpSyncSettings } from "./types";

// Mock ssh2 Client
const mockStream = {
  on: vi.fn(),
  stderr: { on: vi.fn() },
};
const mockConn = {
  on: vi.fn(),
  connect: vi.fn(),
  exec: vi.fn(),
  end: vi.fn(),
};
vi.mock("ssh2", () => ({
  Client: vi.fn(() => mockConn),
}));

// Mock child_process
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { sshExec, testSshConnection, listRemoteFiles } from "./remote";
import { execFile } from "child_process";

function settings(overrides: Partial<SftpSyncSettings> = {}): SftpSyncSettings {
  return { ...DEFAULT_SETTINGS, host: "myhost", port: 22, username: "user", ...overrides };
}

describe("sshExec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should execute command and return stdout", async () => {
    // Setup: conn.on('ready') triggers exec, stream.on('data') returns data, stream.on('close') resolves
    mockConn.on.mockImplementation((event: string, cb: Function) => {
      if (event === "ready") setTimeout(() => cb(), 0);
      return mockConn;
    });
    mockConn.exec.mockImplementation((_cmd: string, cb: Function) => {
      cb(null, mockStream);
    });
    mockStream.on.mockImplementation((event: string, cb: Function) => {
      if (event === "data") setTimeout(() => cb(Buffer.from("hello\n")), 0);
      if (event === "close") setTimeout(() => cb(), 10);
      return mockStream;
    });
    mockStream.stderr.on.mockReturnValue(mockStream);

    const result = await sshExec(settings(), "echo hello");
    expect(result).toBe("hello\n");
    expect(mockConn.exec).toHaveBeenCalledWith("echo hello", expect.any(Function));
  });

  it("should reject on connection error", async () => {
    mockConn.on.mockImplementation((event: string, cb: Function) => {
      if (event === "error") setTimeout(() => cb(new Error("Connection refused")), 0);
      return mockConn;
    });

    await expect(sshExec(settings(), "test")).rejects.toThrow("Connection refused");
  });
});

describe("testSshConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return ok:true on success", async () => {
    mockConn.on.mockImplementation((event: string, cb: Function) => {
      if (event === "ready") setTimeout(() => cb(), 0);
      return mockConn;
    });
    mockConn.exec.mockImplementation((_cmd: string, cb: Function) => {
      cb(null, mockStream);
    });
    mockStream.on.mockImplementation((event: string, cb: Function) => {
      if (event === "data") setTimeout(() => cb(Buffer.from("ok\n")), 0);
      if (event === "close") setTimeout(() => cb(), 10);
      return mockStream;
    });
    mockStream.stderr.on.mockReturnValue(mockStream);

    const result = await testSshConnection(settings());
    expect(result.ok).toBe(true);
  });

  it("should return ok:false on failure", async () => {
    mockConn.on.mockImplementation((event: string, cb: Function) => {
      if (event === "error") setTimeout(() => cb(new Error("Timeout")), 0);
      return mockConn;
    });

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

    mockConn.on.mockImplementation((event: string, cb: Function) => {
      if (event === "ready") setTimeout(() => cb(), 0);
      return mockConn;
    });
    mockConn.exec.mockImplementation((_cmd: string, cb: Function) => {
      cb(null, mockStream);
    });
    mockStream.on.mockImplementation((event: string, cb: Function) => {
      if (event === "data") setTimeout(() => cb(Buffer.from(findOutput)), 0);
      if (event === "close") setTimeout(() => cb(), 10);
      return mockStream;
    });
    mockStream.stderr.on.mockReturnValue(mockStream);

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
    mockConn.on.mockImplementation((event: string, cb: Function) => {
      if (event === "ready") setTimeout(() => cb(), 0);
      return mockConn;
    });
    mockConn.exec.mockImplementation((_cmd: string, cb: Function) => {
      cb(null, mockStream);
    });
    mockStream.on.mockImplementation((event: string, cb: Function) => {
      if (event === "data") setTimeout(() => cb(Buffer.from("")), 0);
      if (event === "close") setTimeout(() => cb(), 10);
      return mockStream;
    });
    mockStream.stderr.on.mockReturnValue(mockStream);

    const files = await listRemoteFiles(settings({ remotePath: "/remote" }), []);
    expect(files).toHaveLength(0);
  });
});

describe("rsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rsyncPull should call execFile with correct args", async () => {
    const { rsyncPull } = await import("./remote");
    (execFile as any).mockImplementation(
      (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, "", "")
    );

    await rsyncPull(
      settings({ privateKeyPath: "/key", remotePath: "/remote" }),
      "/local"
    );

    expect(execFile).toHaveBeenCalledWith(
      "rsync",
      expect.arrayContaining(["-az", "--delete-after"]),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("rsyncPush should call execFile with correct args", async () => {
    const { rsyncPush } = await import("./remote");
    (execFile as any).mockImplementation(
      (_cmd: string, _args: string[], _opts: any, cb: Function) => cb(null, "", "")
    );

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
