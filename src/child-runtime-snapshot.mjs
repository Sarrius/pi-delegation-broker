import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const CHILDREN = ["child-shim.ts", "controller-provider-proxy.ts", "pi-behavioral-enforcement.ts"];

function packageDirectory(require, name) {
  // Resolve package locations without requiring a CommonJS export from ESM-only Pi.
  for (const base of require.resolve.paths(name) ?? []) {
    const path = join(base, name);
    const manifest = join(path, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return realpathSync(path);
  }
  throw new Error(`child runtime dependency unavailable: ${name}`);
}

/** Capture at extension activation, before source edits can alter a live child's graph. */
export function captureChildRuntime(sourceRoot) {
  const names = ["package.json", "extensions/pi-delegation-broker.ts", ...CHILDREN.map((name) => `extensions/${name}`)];
  const walk = (relative) => {
    for (const name of readdirSync(join(sourceRoot, relative)).sort()) {
      const path = `${relative}/${name}`;
      const stat = lstatSync(join(sourceRoot, path));
      if (stat.isSymbolicLink()) throw new Error("child runtime source must not contain symlinks");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) names.push(path);
    }
  };
  walk("src");
  const files = names.map((name) => {
    const bytes = readFileSync(join(sourceRoot, name));
    return { name, bytes, digest: hash(bytes) };
  });
  // Reject a mixed source capture instead of calling it a coherent incarnation.
  for (const file of files) if (hash(readFileSync(join(sourceRoot, file.name))) !== file.digest) {
    throw new Error("child runtime source changed during capture; restart after edits settle");
  }
  const require = createRequire(join(sourceRoot, "package.json"));
  const dependencies = ["typebox", "@earendil-works/pi-ai"].map((name) => ({ name, path: packageDirectory(require, name) }));
  const generation = hash(JSON.stringify(files.map(({ name, digest }) => [name, digest])));
  return Object.freeze({
    generation,
    sourceChanged() {
      return files.some((file) => {
        try { return hash(readFileSync(join(sourceRoot, file.name))) !== file.digest; }
        catch { return true; }
      });
    },
    materialize(parent) {
      const root = join(parent, `child-runtime-${generation.slice(0, 20)}`);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      for (const file of files) {
        const path = join(root, file.name);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (!existsSync(path)) writeFileSync(path, file.bytes, { flag: "wx", mode: 0o400 });
      }
      for (const dependency of dependencies) {
        const path = join(root, "node_modules", dependency.name);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (!existsSync(path)) symlinkSync(dependency.path, path, "dir");
      }
      const verify = () => {
        for (const file of files) {
          const path = join(root, file.name);
          if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || hash(readFileSync(path)) !== file.digest) {
            throw new Error(`child runtime snapshot changed: ${file.name}`);
          }
        }
      };
      verify();
      writeFileSync(join(root, "runtime-manifest.json"), `${JSON.stringify({ generation, files: files.map(({ name, digest }) => ({ name, digest })), dependencies })}\n`, { mode: 0o600 });
      return Object.freeze({ root, generation, verify, extensionPath: (name) => {
        if (!CHILDREN.includes(name)) throw new Error("unknown child extension");
        return join(root, "extensions", name);
      } });
    },
  });
}
