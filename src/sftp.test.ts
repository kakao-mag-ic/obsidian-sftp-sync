import { describe, it, expect, vi, beforeEach } from "vitest";
import { SftpConnection } from "./sftp";
import type { SftpSyncSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

// Mock ssh2-sftp-client
vi.mock("ssh2-sftp-client", () => {
  const mockSftp = {
    connect: vi.fn(),
    end: vi.fn(),
    list: vi.fn(),
    stat: vi.fn(),
    get: vi.fn(),
    put: vi.fn(),
    mkdir: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
  };
  return {
    default: vi.fn(() => mockSftp),
    __mockSftp: mockSftp,
  };
});

// Get the mock instance
import SftpClient from "ssh2-sftp-client";
const mockSftp = (SftpClient as any).__mockSftp ?? new (SftpClient as any)();

function createConnection(overrides: Partial<SftpSyncSettings> = {}): SftpConnection {
  return new SftpConnection({ ...DEFAULT_SETTINGS, ...overrides });
}

describe("SftpConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("connect", () => {
    it("should return true on successful connection", async () => {
      mockSftp.connect.mockResolvedValue(undefined);
      const conn = createConnection({ privateKey: Buffer.from("fake-key").toString("base64") });
      const result = await conn.connect();
      expect(result).toBe(true);
    });

    it("should return false on connection failure", async () => {
      mockSftp.connect.mockRejectedValue(new Error("Connection refused"));
      const conn = createConnection();
      const result = await conn.connect();
      expect(result).toBe(false);
    });

    it("should pass correct config to ssh2-sftp-client", async () => {
      mockSftp.connect.mockResolvedValue(undefined);
      const conn = createConnection({
        host: "myhost",
        port: 22,
        username: "user",
        privateKey: Buffer.from("fake-key").toString("base64"),
        connectTimeoutMs: 3000,
      });
      await conn.connect();
      expect(mockSftp.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "myhost",
          port: 22,
          username: "user",
          readyTimeout: 3000,
        })
      );
    });
  });

  describe("disconnect", () => {
    it("should call end on the client", async () => {
      mockSftp.connect.mockResolvedValue(undefined);
      mockSftp.end.mockResolvedValue(undefined);
      const conn = createConnection();
      await conn.connect();
      await conn.disconnect();
      expect(mockSftp.end).toHaveBeenCalled();
    });
  });

  describe("testConnection", () => {
    it("should return ok:true on success", async () => {
      mockSftp.connect.mockResolvedValue(undefined);
      mockSftp.end.mockResolvedValue(undefined);
      const conn = createConnection();
      const result = await conn.testConnection();
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Success");
    });

    it("should return ok:false on failure", async () => {
      mockSftp.connect.mockRejectedValue(new Error("Timeout"));
      const conn = createConnection();
      const result = await conn.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Timeout");
    });
  });

  describe("list", () => {
    it("should return flat file list from remote directory", async () => {
      mockSftp.connect.mockResolvedValue(undefined);
      mockSftp.list.mockResolvedValue([
        { name: "file1.md", type: "-", size: 100, modifyTime: 1000000, accessTime: 0 },
        { name: "subdir", type: "d", size: 0, modifyTime: 2000000, accessTime: 0 },
      ]);

      const conn = createConnection({ remotePath: "/remote" });
      await conn.connect();
      const files = await conn.list("/remote");
      expect(files).toHaveLength(2);
      expect(files[0]).toEqual({
        path: "file1.md",
        size: 100,
        mtime: 1000000,
        isDirectory: false,
      });
      expect(files[1]).toEqual({
        path: "subdir",
        size: 0,
        mtime: 2000000,
        isDirectory: true,
      });
    });
  });

  describe("listRecursive", () => {
    it("should recursively list all files", async () => {
      // First call: root dir
      mockSftp.list
        .mockResolvedValueOnce([
          { name: "file1.md", type: "-", size: 100, modifyTime: 1000, accessTime: 0 },
          { name: "subdir", type: "d", size: 0, modifyTime: 2000, accessTime: 0 },
        ])
        // Second call: subdir
        .mockResolvedValueOnce([
          { name: "file2.md", type: "-", size: 200, modifyTime: 3000, accessTime: 0 },
        ]);

      mockSftp.connect.mockResolvedValue(undefined);
      const conn = createConnection({ remotePath: "/remote" });
      await conn.connect();
      const files = await conn.listRecursive("/remote");

      expect(files).toHaveLength(2); // Only files, not directories
      expect(files[0].path).toBe("file1.md");
      expect(files[1].path).toBe("subdir/file2.md");
    });
  });

  describe("exists", () => {
    it("should return true if path exists", async () => {
      mockSftp.exists.mockResolvedValue("d");
      mockSftp.connect.mockResolvedValue(undefined);
      const conn = createConnection();
      await conn.connect();
      expect(await conn.exists("/some/path")).toBe(true);
    });

    it("should return false if path does not exist", async () => {
      mockSftp.exists.mockResolvedValue(false);
      mockSftp.connect.mockResolvedValue(undefined);
      const conn = createConnection();
      await conn.connect();
      expect(await conn.exists("/missing")).toBe(false);
    });
  });
});
