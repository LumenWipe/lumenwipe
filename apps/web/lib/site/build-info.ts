import { REPO_URL } from "@/lib/site/trust";

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** The commit this build was made from, as Vercel sets it at build time; null outside a Vercel
 *  build or when the value is not a full commit hash. Prerendered pages read it once, at build. */
export function deployedCommit(): string | null {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  return sha && COMMIT_SHA.test(sha) ? sha : null;
}

/** The commit's page in the repository. */
export function commitUrl(sha: string): string {
  return `${REPO_URL}/commit/${sha}`;
}

/** The short form of a commit hash, as Git prints it. */
export function shortCommit(sha: string): string {
  return sha.slice(0, 7);
}
