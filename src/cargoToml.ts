// Cargo metadata helpers for local-checkout discovery. Parse TOML syntax before inspecting
// specific Cargo tables: comments and unrelated metadata must never create dependencies.
import { parse } from "smol-toml";
import * as path from "path";

type Table = Record<string, unknown>;
function table(value: unknown): Table {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Table : {};
}
function document(text: string): Table {
  try {
    return parse(text, { integersAsBigInt: "asNeeded" });
  } catch {
    // Discovery is best effort; Cargo/the CLI reports malformed manifests when building.
    return {};
  }
}

export function repository(text: string): string | undefined {
  const doc = document(text);
  const own = table(doc.package).repository;
  const inherited = table(table(doc.workspace).package).repository;
  if (typeof own === "string") {
    return own;
  }
  return typeof inherited === "string" ? inherited : undefined;
}

export function lockGitSources(text: string): string[] {
  const packages = document(text).package;
  if (!Array.isArray(packages)) {
    return [];
  }
  return packages.map(pkg => table(pkg).source)
    .filter((source): source is string => typeof source === "string" && source.startsWith("git+"));
}

export function manifestGitSources(text: string): string[] {
  const doc = document(text);
  const scopes = [doc, table(doc.workspace), ...Object.values(table(doc.target)).map(table)];
  return scopes.flatMap(scope => ["dependencies", "build-dependencies", "dev-dependencies"]
    .flatMap(key => Object.values(table(scope[key])))
    .map(dep => table(dep).git)
    .filter((git): git is string => typeof git === "string"));
}

export function hasPathPatch(text: string, root: string, checkout: string): boolean {
  const patches = table(document(text).patch);
  return Object.values(patches).some(source => Object.values(table(source)).some(dep => {
    const local = table(dep).path;
    return typeof local === "string" && path.resolve(root, local) === path.resolve(checkout);
  }));
}
