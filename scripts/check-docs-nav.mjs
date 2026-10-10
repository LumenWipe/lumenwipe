import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const docsDir = process.argv[2] ?? "docs";
const pageExt = /\.mdx?$/;
const endpoint = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /;

function collectPages(node, out) {
  if (typeof node === "string") {
    if (!endpoint.test(node)) out.add(node.replace(/^\//, ""));
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectPages(item, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const key of [
      "pages",
      "groups",
      "tabs",
      "anchors",
      "dropdowns",
      "versions",
      "languages",
    ]) {
      if (node[key]) collectPages(node[key], out);
    }
  }
}

function listPages(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path === join(docsDir, "diagrams") || path === join(docsDir, "logo")) continue;
      listPages(path, out);
    } else if (pageExt.test(entry.name)) {
      out.add(relative(docsDir, path).replace(pageExt, ""));
    }
  }
}

const config = JSON.parse(readFileSync(join(docsDir, "docs.json"), "utf8"));
const listed = new Set();
collectPages(config.navigation, listed);
const onDisk = new Set();
listPages(docsDir, onDisk);

let failed = false;
for (const page of [...onDisk].sort()) {
  if (!listed.has(page)) {
    console.error(
      `::error file=${docsDir}/docs.json::${page} exists under ${docsDir}/ but is not in the navigation`
    );
    failed = true;
  }
}
for (const page of [...listed].sort()) {
  if (!onDisk.has(page)) {
    console.error(
      `::error file=${docsDir}/docs.json::navigation lists ${page} but no such page exists`
    );
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
