import { readFileSync } from "node:fs";

/**
 * Read the package version beside a compiled package entry point.
 *
 * Callers pass their own `import.meta.url` so this works for every package in
 * the monorepo while keeping the package manifest out of the module graph.
 */
export function pkgVersion(importMetaUrl: string): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", importMetaUrl), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
