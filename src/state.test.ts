import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncState } from "./state";
import type { SyncRecord } from "./types";

// Mock localforage
const store = new Map<string, any>();
vi.mock("localforage", () => ({
  default: {
    createInstance: vi.fn(() => ({
      getItem: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      setItem: vi.fn((key: string, value: any) => {
        store.set(key, value);
        return Promise.resolve(value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
        return Promise.resolve();
      }),
      clear: vi.fn(() => {
        store.clear();
        return Promise.resolve();
      }),
      keys: vi.fn(() => Promise.resolve(Array.from(store.keys()))),
    })),
  },
}));

describe("SyncState", () => {
  let state: SyncState;

  beforeEach(() => {
    store.clear();
    state = new SyncState();
  });

  it("should return empty map when no records exist", async () => {
    const records = await state.load();
    expect(records.size).toBe(0);
  });

  it("should set and get a single record", async () => {
    const record: SyncRecord = { path: "notes/hello.md", mtime: 1000, size: 200 };
    await state.setRecord("notes/hello.md", record);

    const result = await state.getRecord("notes/hello.md");
    expect(result).toEqual(record);
  });

  it("should return null for non-existent record", async () => {
    const result = await state.getRecord("nonexistent.md");
    expect(result).toBeNull();
  });

  it("should save and load full map", async () => {
    const records = new Map<string, SyncRecord>([
      ["a.md", { path: "a.md", mtime: 1000, size: 100 }],
      ["b.md", { path: "b.md", mtime: 2000, size: 200 }],
      ["dir/c.md", { path: "dir/c.md", mtime: 3000, size: 300 }],
    ]);

    await state.save(records);
    const loaded = await state.load();
    expect(loaded.size).toBe(3);
    expect(loaded.get("a.md")).toEqual({ path: "a.md", mtime: 1000, size: 100 });
    expect(loaded.get("dir/c.md")).toEqual({ path: "dir/c.md", mtime: 3000, size: 300 });
  });

  it("should delete a record", async () => {
    await state.setRecord("file.md", { path: "file.md", mtime: 1000, size: 100 });
    await state.deleteRecord("file.md");
    const result = await state.getRecord("file.md");
    expect(result).toBeNull();
  });

  it("should clear all records", async () => {
    await state.setRecord("a.md", { path: "a.md", mtime: 1000, size: 100 });
    await state.setRecord("b.md", { path: "b.md", mtime: 2000, size: 200 });
    await state.clear();
    const loaded = await state.load();
    expect(loaded.size).toBe(0);
  });

  it("should overwrite existing record", async () => {
    await state.setRecord("file.md", { path: "file.md", mtime: 1000, size: 100 });
    await state.setRecord("file.md", { path: "file.md", mtime: 2000, size: 300 });
    const result = await state.getRecord("file.md");
    expect(result).toEqual({ path: "file.md", mtime: 2000, size: 300 });
  });
});
