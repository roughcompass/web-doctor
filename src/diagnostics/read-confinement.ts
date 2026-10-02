import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Preloaded into a provider program that must see the application as a
 * standalone project. A read outside the granted roots behaves as if the
 * path did not exist, instead of failing with a permission error that
 * third-party tools treat as fatal. Node's permission model still enforces
 * the same boundary underneath; this only changes how the refusal looks.
 * Writes are not changed, so an attempted write outside the grant stays a
 * visible denial.
 */

const roots = (JSON.parse(process.env.WEB_DOCTOR_READ_ROOTS ?? "[]") as string[]).map((root) => path.resolve(root));

function inside(target: string): boolean {
  return roots.some((root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`));
}

function outside(candidate: unknown): string | null {
  let target: string;
  if (typeof candidate === "string") target = candidate;
  else if (candidate instanceof URL && candidate.protocol === "file:") target = fileURLToPath(candidate);
  else return null;
  if (target.startsWith("node:")) return null;
  const resolved = path.resolve(target);
  return inside(resolved) ? null : resolved;
}

function missing(syscall: string, target: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, ${syscall} '${target}'`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.errno = -2;
  error.syscall = syscall;
  error.path = target;
  return error;
}

type Callable = (...args: unknown[]) => unknown;
const fsRecord = fs as unknown as Record<string, Callable>;
const promisesRecord = fs.promises as unknown as Record<string, Callable>;

for (const name of ["statSync", "lstatSync", "readdirSync", "readFileSync", "openSync", "accessSync", "realpathSync", "opendirSync", "readlinkSync"]) {
  const original = fsRecord[name];
  if (typeof original !== "function") continue;
  fsRecord[name] = function confined(this: unknown, ...args: unknown[]) {
    const target = outside(args[0]);
    if (target !== null) {
      const options = args[1] as { throwIfNoEntry?: boolean } | undefined;
      if ((name === "statSync" || name === "lstatSync") && options?.throwIfNoEntry === false) return undefined;
      throw missing(name.replace(/Sync$/, ""), target);
    }
    return original.apply(this, args);
  };
}
{
  const original = fsRecord.existsSync!;
  fsRecord.existsSync = function confined(this: unknown, ...args: unknown[]) {
    return outside(args[0]) === null ? original.apply(this, args) : false;
  };
}
for (const name of ["stat", "lstat", "readdir", "readFile", "open", "access", "realpath", "opendir", "readlink"]) {
  const original = fsRecord[name];
  if (typeof original === "function") {
    fsRecord[name] = function confined(this: unknown, ...args: unknown[]) {
      const target = outside(args[0]);
      const callback = args.at(-1);
      if (target !== null && typeof callback === "function") {
        process.nextTick(() => (callback as (error: unknown) => void)(missing(name, target)));
        return undefined;
      }
      return original.apply(this, args);
    };
  }
  const promised = promisesRecord[name];
  if (typeof promised === "function") {
    promisesRecord[name] = function confined(this: unknown, ...args: unknown[]) {
      const target = outside(args[0]);
      return target === null ? promised.apply(this, args) : Promise.reject(missing(name, target));
    };
  }
}
module.syncBuiltinESMExports();
