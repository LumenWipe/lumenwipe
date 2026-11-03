import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderContrastTables } from "../apps/web/tests/design-tokens";
import { contrastRegion, TOKEN_PAGE, tokenVars } from "./check-docs-claims";

const root = resolve(process.argv[2] ?? join(import.meta.dir, ".."));
const vars = tokenVars(root);
if (vars === null) throw new Error("apps/web/app/globals.css is missing");
const path = join(root, TOKEN_PAGE);
const page = readFileSync(path, "utf8");
const region = contrastRegion(page);
if (region === null) throw new Error(`${TOKEN_PAGE} has no contrast markers`);
writeFileSync(
  path,
  `${page.slice(0, region.start)}\n\n${renderContrastTables(vars)}\n\n${page.slice(region.end)}`
);
console.log(`Wrote the measured contrast tables to ${TOKEN_PAGE}.`);
