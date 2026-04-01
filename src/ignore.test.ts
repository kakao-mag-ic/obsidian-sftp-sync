import { describe, it, expect } from "vitest";
import { shouldIgnore, DEFAULT_IGNORE_PATTERNS } from "./ignore";

describe("shouldIgnore", () => {
  it("should ignore exact directory matches", () => {
    expect(shouldIgnore(".obsidian/config.json", [".obsidian"])).toBe(true);
    expect(shouldIgnore(".git/HEAD", [".git"])).toBe(true);
    expect(shouldIgnore("node_modules/foo/bar.js", ["node_modules"])).toBe(true);
  });

  it("should ignore exact file matches", () => {
    expect(shouldIgnore(".env", [".env"])).toBe(true);
    expect(shouldIgnore(".DS_Store", [".DS_Store"])).toBe(true);
  });

  it("should NOT ignore non-matching paths", () => {
    expect(shouldIgnore("notes/hello.md", [".obsidian", ".git"])).toBe(false);
    expect(shouldIgnore("src/main.ts", ["node_modules"])).toBe(false);
  });

  it("should match wildcard patterns (*.ext)", () => {
    expect(shouldIgnore("cache/foo.pyc", ["*.pyc"])).toBe(true);
    expect(shouldIgnore("deep/nested/bar.pyc", ["*.pyc"])).toBe(true);
    expect(shouldIgnore("foo.py", ["*.pyc"])).toBe(false);
  });

  it("should match nested directory patterns", () => {
    expect(shouldIgnore("__pycache__/module.cpython.pyc", ["__pycache__"])).toBe(true);
    expect(shouldIgnore("src/__pycache__/module.pyc", ["__pycache__"])).toBe(true);
  });

  it("should handle trailing slash patterns as directory-only", () => {
    expect(shouldIgnore(".obsidian/plugins/foo", [".obsidian/"])).toBe(true);
  });

  it("should handle empty patterns list", () => {
    expect(shouldIgnore("anything.md", [])).toBe(false);
  });

  it("should handle paths with leading slash normalization", () => {
    expect(shouldIgnore("/notes/hello.md", [".obsidian"])).toBe(false);
    expect(shouldIgnore("/.obsidian/config", [".obsidian"])).toBe(true);
  });

  it("should have sensible default ignore patterns", () => {
    expect(DEFAULT_IGNORE_PATTERNS).toContain(".obsidian");
    expect(DEFAULT_IGNORE_PATTERNS).toContain(".git");
    expect(DEFAULT_IGNORE_PATTERNS).toContain("node_modules");
    expect(DEFAULT_IGNORE_PATTERNS).toContain("__pycache__");
    expect(DEFAULT_IGNORE_PATTERNS).toContain("*.pyc");
    expect(DEFAULT_IGNORE_PATTERNS).toContain(".env");
  });
});
