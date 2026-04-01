export const DEFAULT_IGNORE_PATTERNS: string[] = [
  ".obsidian",
  ".git",
  ".gitignore",
  "node_modules",
  "__pycache__",
  "*.pyc",
  ".env",
  ".DS_Store",
  "Thumbs.db",
];

/**
 * Check if a file path should be ignored based on the given patterns.
 *
 * Supported patterns:
 * - "foo"       → matches if any path segment equals "foo" or path starts with "foo/"
 * - "*.ext"     → matches if the file ends with .ext
 * - "foo/"      → same as "foo" (trailing slash stripped, treated as directory prefix)
 */
export function shouldIgnore(filePath: string, patterns: string[]): boolean {
  // Normalize: strip leading slash
  const normalized = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  const segments = normalized.split("/");

  for (const raw of patterns) {
    const pattern = raw.endsWith("/") ? raw.slice(0, -1) : raw;

    // Wildcard: *.ext
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1); // ".pyc"
      const fileName = segments[segments.length - 1];
      if (fileName.endsWith(ext)) {
        return true;
      }
      continue;
    }

    // Exact segment match: any segment equals pattern, or path starts with pattern/
    for (const seg of segments) {
      if (seg === pattern) {
        return true;
      }
    }
  }

  return false;
}
