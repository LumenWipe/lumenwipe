import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export class LabRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabRefusal";
  }
}

/** The repository checkout this tool runs from: the nearest ancestor holding `.git`. */
export function checkoutRoot(from: string = import.meta.dir): string {
  let dir = resolve(from);
  while (!existsSync(join(dir, ".git"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new LabRefusal(`no repository checkout above ${from}`);
    dir = parent;
  }
  return dir;
}

/** Resolves symlinks on the longest existing prefix, so a path that does not exist yet is
 *  still compared by where it would really land. */
function realPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(realPath(parent), absolute.slice(parent.length));
}

export function isInside(path: string, root: string): boolean {
  const rel = relative(realPath(root), realPath(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Whether the path sits in any git checkout or worktree, not only the one the lab runs from. */
export function insideAnyCheckout(path: string): boolean {
  let dir = realPath(path);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Credentials and results never live in a checkout, where they get copied, zipped and shared. */
export function assertOutsideCheckout(path: string, what: string, root = checkoutRoot()): string {
  if (isInside(path, root) || insideAnyCheckout(path)) {
    throw new LabRefusal(`${what} must live outside the repository checkout, not at ${path}`);
  }
  return path;
}

export function labHome(env: NodeJS.ProcessEnv = process.env, root = checkoutRoot()): string {
  const home = env.LUMENWIPE_LAB_HOME || join(homedir(), ".lumenwipe", "lab");
  return assertOutsideCheckout(resolve(home), "The lab folder", root);
}

/** Reads a credential file: outside the checkout, a regular file, and readable by its owner only. */
export function readPrivateFile(path: string, what: string, root = checkoutRoot()): string {
  assertOutsideCheckout(path, what, root);
  if (!existsSync(path)) throw new LabRefusal(`${what} not found at ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new LabRefusal(`${what} at ${path} is not a regular file`);
  if ((stat.mode & 0o077) !== 0) {
    throw new LabRefusal(`${what} at ${path} is readable by others: run chmod 600 on it`);
  }
  const value = readFileSync(path, "utf8").trim();
  if (value === "") throw new LabRefusal(`${what} at ${path} is empty`);
  return value;
}

export const API_KEY_ENV = "LUMENWIPE_LAB_API_KEY";

/** The production API key: from the environment, or from `keys/api-key` in the lab folder. */
export function productionApiKey(
  env: NodeJS.ProcessEnv = process.env,
  home = labHome(env),
  root = checkoutRoot()
): string {
  const fromEnv = env[API_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const file = join(home, "keys", "api-key");
  if (!existsSync(file)) {
    throw new LabRefusal(
      `The production target needs an API key: set ${API_KEY_ENV} or write it to ${file} (chmod 600). Run --target local to measure without one.`
    );
  }
  return readPrivateFile(file, "The API key file", root);
}

/** The environment for the build and helper commands: without the lab's own variables, so the
 *  production key never reaches a build tool. */
export function withoutLabEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("LUMENWIPE_LAB_")));
}
