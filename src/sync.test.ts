import { describe, it, expect } from "vitest";
import { buildSyncPlan, type SyncContext } from "./sync";
import type { FileInfo, SyncRecord, SftpSyncSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

function makeFile(path: string, mtime: number, size: number): FileInfo {
  return { path, mtime, size, isDirectory: false };
}

function makeRecord(path: string, mtime: number, size: number): SyncRecord {
  return { path, mtime, size };
}

function makeContext(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    localFiles: [],
    remoteFiles: [],
    prevRecords: new Map(),
    settings: { ...DEFAULT_SETTINGS, syncDirection: "pull_only" },
    ...overrides,
  };
}

describe("buildSyncPlan - pull_only mode", () => {
  it("should download files that exist only on remote", () => {
    const ctx = makeContext({
      remoteFiles: [makeFile("notes/hello.md", 1000, 200)],
    });
    const plan = buildSyncPlan(ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0].decision).toBe("download");
    expect(plan[0].path).toBe("notes/hello.md");
  });

  it("should skip files that exist only locally (pull_only doesn't upload)", () => {
    const ctx = makeContext({
      localFiles: [makeFile("local-only.md", 1000, 100)],
    });
    const plan = buildSyncPlan(ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0].decision).toBe("skip");
  });

  it("should skip files unchanged since last sync", () => {
    const ctx = makeContext({
      localFiles: [makeFile("file.md", 1000, 200)],
      remoteFiles: [makeFile("file.md", 1000, 200)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0].decision).toBe("skip");
  });

  it("should download files modified on remote since last sync", () => {
    const ctx = makeContext({
      localFiles: [makeFile("file.md", 1000, 200)],
      remoteFiles: [makeFile("file.md", 2000, 300)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0].decision).toBe("download");
  });

  it("should skip files modified only locally in pull_only mode", () => {
    const ctx = makeContext({
      localFiles: [makeFile("file.md", 2000, 300)],
      remoteFiles: [makeFile("file.md", 1000, 200)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0].decision).toBe("skip");
  });

  it("should download when both changed (pull_only always takes remote)", () => {
    const ctx = makeContext({
      localFiles: [makeFile("file.md", 3000, 400)],
      remoteFiles: [makeFile("file.md", 2000, 300)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0].decision).toBe("download");
  });

  it("should handle first sync - both exist, use newer", () => {
    const ctx = makeContext({
      localFiles: [makeFile("file.md", 1000, 200)],
      remoteFiles: [makeFile("file.md", 2000, 300)],
    });
    const plan = buildSyncPlan(ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0].decision).toBe("download");
  });

  it("should skip on first sync when both exist with same mtime", () => {
    const ctx = makeContext({
      localFiles: [makeFile("file.md", 1000, 200)],
      remoteFiles: [makeFile("file.md", 1000, 200)],
    });
    const plan = buildSyncPlan(ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0].decision).toBe("skip");
  });

  it("should not delete local files even if remote deleted (pull_only, deleteSync=false)", () => {
    const ctx = makeContext({
      localFiles: [makeFile("file.md", 1000, 200)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0].decision).toBe("skip");
  });

  it("should delete_local when remote deleted and deleteSync=true in pull_only", () => {
    const ctx = makeContext({
      localFiles: [makeFile("file.md", 1000, 200)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
      settings: { ...DEFAULT_SETTINGS, syncDirection: "pull_only", deleteSync: true },
    });
    const plan = buildSyncPlan(ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0].decision).toBe("delete_local");
  });

  it("should handle multiple files correctly", () => {
    const ctx = makeContext({
      localFiles: [
        makeFile("a.md", 1000, 100),
        makeFile("b.md", 1000, 100),
      ],
      remoteFiles: [
        makeFile("b.md", 2000, 200),
        makeFile("c.md", 3000, 300),
      ],
      prevRecords: new Map([
        ["a.md", makeRecord("a.md", 1000, 100)],
        ["b.md", makeRecord("b.md", 1000, 100)],
      ]),
    });
    const plan = buildSyncPlan(ctx);
    const decisions = new Map(plan.map((e) => [e.path, e.decision]));
    expect(decisions.get("a.md")).toBe("skip"); // remote deleted, deleteSync=false → skip
    expect(decisions.get("b.md")).toBe("download"); // remote modified
    expect(decisions.get("c.md")).toBe("download"); // new on remote
  });
});

// --- push_only ---

function makePushContext(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    localFiles: [],
    remoteFiles: [],
    prevRecords: new Map(),
    settings: { ...DEFAULT_SETTINGS, syncDirection: "push_only" },
    ...overrides,
  };
}

describe("buildSyncPlan - push_only mode", () => {
  it("should upload files that exist only locally", () => {
    const ctx = makePushContext({
      localFiles: [makeFile("local.md", 1000, 100)],
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("upload");
  });

  it("should skip files that exist only on remote", () => {
    const ctx = makePushContext({
      remoteFiles: [makeFile("remote.md", 1000, 100)],
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("skip");
  });

  it("should upload when local modified", () => {
    const ctx = makePushContext({
      localFiles: [makeFile("file.md", 2000, 300)],
      remoteFiles: [makeFile("file.md", 1000, 200)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("upload");
  });

  it("should skip when only remote modified", () => {
    const ctx = makePushContext({
      localFiles: [makeFile("file.md", 1000, 200)],
      remoteFiles: [makeFile("file.md", 2000, 300)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("skip");
  });

  it("should delete_remote when local deleted and deleteSync=true", () => {
    const ctx = makePushContext({
      remoteFiles: [makeFile("file.md", 1000, 200)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
      settings: { ...DEFAULT_SETTINGS, syncDirection: "push_only", deleteSync: true },
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("delete_remote");
  });
});

// --- bidirectional ---

function makeBidiContext(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    localFiles: [],
    remoteFiles: [],
    prevRecords: new Map(),
    settings: { ...DEFAULT_SETTINGS, syncDirection: "bidirectional" },
    ...overrides,
  };
}

describe("buildSyncPlan - bidirectional mode", () => {
  it("should upload when only local changed", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("file.md", 2000, 300)],
      remoteFiles: [makeFile("file.md", 1000, 200)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("upload");
  });

  it("should download when only remote changed", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("file.md", 1000, 200)],
      remoteFiles: [makeFile("file.md", 2000, 300)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("download");
  });

  it("should resolve conflict with newer_wins (remote newer)", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("file.md", 2000, 300)],
      remoteFiles: [makeFile("file.md", 3000, 400)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
      settings: { ...DEFAULT_SETTINGS, syncDirection: "bidirectional", conflictStrategy: "newer_wins" },
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("download");
  });

  it("should resolve conflict with newer_wins (local newer)", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("file.md", 3000, 300)],
      remoteFiles: [makeFile("file.md", 2000, 400)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
      settings: { ...DEFAULT_SETTINGS, syncDirection: "bidirectional", conflictStrategy: "newer_wins" },
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("upload");
  });

  it("should resolve conflict with local_wins", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("file.md", 2000, 300)],
      remoteFiles: [makeFile("file.md", 3000, 400)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
      settings: { ...DEFAULT_SETTINGS, syncDirection: "bidirectional", conflictStrategy: "local_wins" },
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("upload");
  });

  it("should resolve conflict with remote_wins", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("file.md", 3000, 300)],
      remoteFiles: [makeFile("file.md", 2000, 400)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
      settings: { ...DEFAULT_SETTINGS, syncDirection: "bidirectional", conflictStrategy: "remote_wins" },
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("download");
  });

  it("should resolve conflict with larger_wins", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("file.md", 2000, 500)],
      remoteFiles: [makeFile("file.md", 3000, 300)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
      settings: { ...DEFAULT_SETTINGS, syncDirection: "bidirectional", conflictStrategy: "larger_wins" },
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("upload"); // local is larger
  });

  it("should delete_local when remote deleted, local unchanged, deleteSync=true", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("file.md", 1000, 200)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
      settings: { ...DEFAULT_SETTINGS, syncDirection: "bidirectional", deleteSync: true },
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("delete_local");
  });

  it("should delete_remote when local deleted, remote unchanged, deleteSync=true", () => {
    const ctx = makeBidiContext({
      remoteFiles: [makeFile("file.md", 1000, 200)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
      settings: { ...DEFAULT_SETTINGS, syncDirection: "bidirectional", deleteSync: true },
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("delete_remote");
  });

  it("should upload when local changed but remote deleted (restore)", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("file.md", 2000, 300)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("upload");
  });

  it("should download when remote changed but local deleted (restore)", () => {
    const ctx = makeBidiContext({
      remoteFiles: [makeFile("file.md", 2000, 300)],
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("download");
  });

  it("should skip when both deleted", () => {
    const ctx = makeBidiContext({
      prevRecords: new Map([["file.md", makeRecord("file.md", 1000, 200)]]),
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("skip");
  });

  it("first sync: local only → upload", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("local.md", 1000, 100)],
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("upload");
  });

  it("first sync: remote only → download", () => {
    const ctx = makeBidiContext({
      remoteFiles: [makeFile("remote.md", 1000, 100)],
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("download");
  });

  it("first sync: both exist, remote newer → download", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("file.md", 1000, 100)],
      remoteFiles: [makeFile("file.md", 2000, 200)],
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("download");
  });

  it("first sync: both exist, local newer → upload", () => {
    const ctx = makeBidiContext({
      localFiles: [makeFile("file.md", 2000, 200)],
      remoteFiles: [makeFile("file.md", 1000, 100)],
    });
    const plan = buildSyncPlan(ctx);
    expect(plan[0].decision).toBe("upload");
  });
});
