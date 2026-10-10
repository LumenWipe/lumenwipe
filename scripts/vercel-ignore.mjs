import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHARED = [
  "packages/sdk/",
  "packages/types/",
  "package.json",
  "bun.lock",
  "tsconfig.base.json",
  ".npmrc",
  ".tool-versions",
];

// apps/web bundles apps/api/src/config/*.json through its `@registry/*` tsconfig path.
export const WATCHED = {
  web: ["apps/web/", "apps/api/src/config/", ...SHARED],
  playground: ["apps/playground/", ...SHARED],
};

const SHA = /^[0-9a-f]{40}$/;
const NO_SHA = /^0+$/;

export function shouldBuild(app, changedFiles) {
  const watched = WATCHED[app];
  if (!watched || changedFiles.length === 0) return true;
  return changedFiles.some((file) =>
    watched.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry))
  );
}

export function decide(app, base, diff) {
  if (!WATCHED[app]) return { build: true, reason: `unknown app "${app}"` };
  if (!base || !SHA.test(base) || NO_SHA.test(base)) {
    return { build: true, reason: "no previous deployed commit to compare against" };
  }
  let files;
  try {
    files = diff(base);
  } catch {
    return { build: true, reason: "could not compare against the previous deployed commit" };
  }
  if (files.length === 0) return { build: true, reason: "the comparison returned no files" };
  return shouldBuild(app, files)
    ? { build: true, reason: "a file this app depends on changed" }
    : { build: false, reason: "no file this app depends on changed" };
}

function gitDiff(base) {
  const out = execFileSync("git", ["diff", "--name-only", base, "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.split("\n").filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { build, reason } = decide(process.argv[2], process.env.VERCEL_GIT_PREVIOUS_SHA, gitDiff);
  console.log(`${build ? "Building" : "Skipping"}: ${reason}`);
  process.exit(build ? 1 : 0);
}
