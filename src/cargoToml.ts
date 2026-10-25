// Cargo metadata helpers for local-checkout discovery. Parse TOML syntax before inspecting
// specific Cargo tables: comments and unrelated metadata must never create dependencies.
import { parse } from "smol-toml";
import * as fs from "fs";
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
    if (typeof local !== "string") { return false; }
    const relative = path.relative(path.resolve(checkout), path.resolve(root, local));
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  }));
}

const DEPENDENCY_KEYS = ["dependencies", "build-dependencies", "dev-dependencies"];

/** The package names a manifest asks crates.io for: plain versions in every dependency table,
 *  under the package name a `package =` rename gives. Git, path and workspace-inherited entries
 *  are not registry dependencies (the inherited ones are read from `[workspace.dependencies]`). */
export function registryDependencies(text: string): string[] {
  const doc = document(text);
  const scopes = [doc, table(doc.workspace), ...Object.values(table(doc.target)).map(table)];
  return scopes.flatMap(scope => DEPENDENCY_KEYS.flatMap(key => Object.entries(table(scope[key]))))
    .flatMap(([key, dep]) => {
      if (typeof dep === "string") { return [key]; }
      const spec = table(dep);
      if ("git" in spec || "path" in spec || "workspace" in spec) { return []; }
      return [typeof spec.package === "string" ? spec.package : key];
    });
}

/** The names of the lockfile's packages that come from a registry. */
export function lockRegistryPackages(text: string): string[] {
  const packages = document(text).package;
  if (!Array.isArray(packages)) {
    return [];
  }
  return packages.map(table)
    .filter(pkg => typeof pkg.source === "string"
      && (pkg.source.startsWith("registry+") || pkg.source.startsWith("sparse+")))
    .map(pkg => pkg.name)
    .filter((name): name is string => typeof name === "string");
}

/** The packages a cargo checkout carries: its root package and every workspace member (a
 *  trailing `/*` member is every directory under it). What `day patch --local` would offer to
 *  take from it. */
export function checkoutPackages(dir: string): string[] {
  const read = (file: string): string => {
    try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
  };
  const nameOf = (manifest: string): string | undefined => {
    const name = table(document(read(manifest)).package).name;
    return typeof name === "string" ? name : undefined;
  };
  const names = new Set<string>();
  const root = path.join(dir, "Cargo.toml");
  const own = nameOf(root);
  if (own) { names.add(own); }
  const members = table(document(read(root)).workspace).members;
  for (const member of Array.isArray(members) ? members : []) {
    if (typeof member !== "string") { continue; }
    const dirs = member.endsWith("/*")
      ? (() => {
        const parent = path.join(dir, member.slice(0, -2));
        try { return fs.readdirSync(parent).map(entry => path.join(parent, entry)); } catch { return []; }
      })()
      : [path.join(dir, member)];
    for (const memberDir of dirs) {
      const name = nameOf(path.join(memberDir, "Cargo.toml"));
      if (name) { names.add(name); }
    }
  }
  return [...names];
}
