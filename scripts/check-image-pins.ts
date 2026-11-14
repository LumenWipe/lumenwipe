// Fails when the API image stops being built from pinned inputs: the `# syntax=` frontend and every
// base image in apps/api/Dockerfile must be `name:version@sha256:<64 hex>`, the Bun image's version
// must be the Bun in .tool-versions (and every workflow's Bun pin must agree), and the Node image's
// version must be the Node in .tool-versions. Renovate moves these together; this catches the case
// where it, or a hand edit, moves only some of them.
// Usage: bun scripts/check-image-pins.ts (from the repo root)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PINNED =
  /^(?<name>[a-z0-9][a-z0-9._/-]*):(?<tag>[A-Za-z0-9][A-Za-z0-9._-]*)@sha256:[0-9a-f]{64}$/;

export interface PinInputs {
  dockerfile: string;
  toolVersions: string;
  // Workflow file name -> contents.
  workflows: Record<string, string>;
}

function toolVersion(toolVersions: string, tool: string): string | undefined {
  for (const line of toolVersions.split("\n")) {
    const [name, version] = line.trim().split(/\s+/);
    if (name === tool && version) return version;
  }
  return undefined;
}

// The version part of a tag: "1.4.4" from "1.4.4", "26.13.1" from "26.13.1-slim".
function tagVersion(tag: string): string {
  return tag.split("-")[0];
}

export function checkPins({ dockerfile, toolVersions, workflows }: PinInputs): string[] {
  const errors: string[] = [];
  const bun = toolVersion(toolVersions, "bun");
  const node = toolVersion(toolVersions, "nodejs");
  if (!bun) errors.push(".tool-versions has no bun version");
  if (!node) errors.push(".tool-versions has no nodejs version");

  const stages = new Set<string>();
  const refs: { ref: string; where: string }[] = [];
  let sawSyntax = false;
  let sawFrom = false;
  for (const [index, line] of dockerfile.split("\n").entries()) {
    const where = `apps/api/Dockerfile:${index + 1}`;
    const syntax = /^#\s*syntax\s*=\s*(\S+)/.exec(line);
    if (syntax) {
      sawSyntax = true;
      refs.push({ ref: syntax[1], where });
      continue;
    }
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!from) continue;
    sawFrom = true;
    // FROM <earlier stage> builds on that stage, not on a registry image.
    const earlierStage = stages.has(from[1].toLowerCase());
    if (from[2]) stages.add(from[2].toLowerCase());
    if (!earlierStage) refs.push({ ref: from[1], where });
  }
  if (!sawSyntax) errors.push("apps/api/Dockerfile has no pinned `# syntax=` line");
  if (!sawFrom) errors.push("apps/api/Dockerfile has no FROM line");

  for (const { ref, where } of refs) {
    const pinned = PINNED.exec(ref);
    if (!pinned?.groups) {
      errors.push(`${where}: ${ref} is not pinned as name:version@sha256:<64 hex digits>`);
      continue;
    }
    const { name, tag } = pinned.groups;
    if (name === "oven/bun" && bun && tagVersion(tag) !== bun) {
      errors.push(`${where}: oven/bun:${tag} is not the Bun in .tool-versions (${bun})`);
    }
    if (name === "node" && node && tagVersion(tag) !== node) {
      errors.push(`${where}: node:${tag} is not the Node in .tool-versions (${node})`);
    }
  }

  if (bun) {
    for (const [file, text] of Object.entries(workflows)) {
      for (const [index, line] of text.split("\n").entries()) {
        const pin =
          /^\s*bun-version:\s*["']?([^"'\s#]+)/.exec(line) ?? /npm install -g bun@(\S+)/.exec(line);
        if (pin && pin[1] !== bun) {
          errors.push(
            `.github/workflows/${file}:${index + 1}: Bun ${pin[1]} is not the Bun in .tool-versions (${bun})`
          );
        }
      }
    }
  }
  return errors;
}

export function readInputs(root: string): PinInputs {
  const dir = join(root, ".github", "workflows");
  const workflows: Record<string, string> = {};
  for (const file of readdirSync(dir).sort()) {
    if (/\.ya?ml$/.test(file)) workflows[file] = readFileSync(join(dir, file), "utf8");
  }
  return {
    dockerfile: readFileSync(join(root, "apps", "api", "Dockerfile"), "utf8"),
    toolVersions: readFileSync(join(root, ".tool-versions"), "utf8"),
    workflows,
  };
}

if (import.meta.main) {
  const errors = checkPins(readInputs(process.cwd()));
  for (const error of errors) console.error(`::error::${error}`);
  if (errors.length > 0) process.exit(1);
  console.log(
    "The API image's base images and syntax frontend are pinned and agree with .tool-versions."
  );
}
