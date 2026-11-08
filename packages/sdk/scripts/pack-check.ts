// Packs the SDK the way npm publishes it and checks the tarball as a consumer would see it:
// the exact file list, publint, attw, an offline install into an empty project, `import` and
// `require` exposing the same working client, and a type-check with the current and the minimum
// supported TypeScript. Run after `build`. Prints the tarball path; with PACK_OUT_DIR set the
// tarball is written there, and under GitHub Actions its path is also the `tarball` step output.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Every file the published tarball may contain, and must contain. */
export const PACK_ALLOWLIST = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "dist/index.cjs",
  "dist/index.d.cts",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
] as const;

/** The oldest TypeScript the published declarations are checked against (README, Requirements). */
export const MINIMUM_TYPESCRIPT = "4.7";

export function checkPackList(files: readonly string[]): string[] {
  const problems: string[] = [];
  const allowed = new Set<string>(PACK_ALLOWLIST);
  const present = new Set(files);
  for (const file of PACK_ALLOWLIST) {
    if (!present.has(file)) problems.push(`missing from the tarball: ${file}`);
  }
  for (const file of files) {
    if (!allowed.has(file)) problems.push(`not on the allowlist: ${file}`);
  }
  if (present.size !== files.length) problems.push("the tarball lists a file twice");
  return problems;
}

/** Sorted export names and a client round trip, printed as JSON by both consumer scripts. */
const PROBE = `
  const names = Object.keys(sdk).sort();
  let header = null;
  const client = new sdk.LumenWipeClient({
    baseUrl: "https://api.example.test",
    apiKey: "k",
    network: "testnet",
    fetch: async (_url, init) => {
      header = new Headers(init && init.headers).get("X-LumenWipe-SDK");
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const health = await client.health();
  console.log(JSON.stringify({ names, header, health }));
`;

const CONSUMER_ESM = `import * as sdk from "@lumenwipe/sdk";\n${PROBE}`;
const CONSUMER_CJS = `const sdk = require("@lumenwipe/sdk");\n(async () => {${PROBE}})();\n`;

const TYPES_ESM = `import { LumenWipeClient, LumenWipeApiError, type AccountState } from "@lumenwipe/sdk";
export const client: LumenWipeClient = new LumenWipeClient({
  baseUrl: "https://api.example.test",
  apiKey: "k",
  network: "testnet",
});
export const errorClass: typeof LumenWipeApiError = LumenWipeApiError;
export type Account = AccountState;
`;

const TYPES_CJS = `import sdk = require("@lumenwipe/sdk");
const client: sdk.LumenWipeClient = new sdk.LumenWipeClient({
  baseUrl: "https://api.example.test",
  apiKey: "k",
  network: "testnet",
});
const account: sdk.AccountState | null = null;
export = { client, errorClass: sdk.LumenWipeApiError, account };
`;

const BASE_OPTIONS = {
  target: "es2022",
  lib: ["es2022", "dom"],
  strict: true,
  noEmit: true,
  skipLibCheck: false,
  types: [],
};

const SDK = resolve(import.meta.dir, "..");

function run(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    throw new Error(
      `${[command, ...args].join(" ")} failed in ${cwd}\n${failed.stdout ?? ""}${failed.stderr ?? ""}`,
      { cause: error }
    );
  }
}

/** The JS file a dependency's bin points at, run with node so its own shebang does not matter. */
function binOf(pkg: string, bin: string): string {
  const manifestPath = Bun.resolveSync(`${pkg}/package.json`, SDK);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const target = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
  if (!target) throw new Error(`${pkg} has no ${bin} bin`);
  return join(dirname(manifestPath), target);
}

function step(name: string, body: () => void): void {
  console.log(`- ${name}`);
  body();
}

function main(): void {
  const node = run("node", ["-p", "process.versions.node"], SDK).trim();
  const engines = (
    JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as {
      engines: { node: string };
    }
  ).engines.node;
  const floor = Number(/^>=(\d+)$/.exec(engines)?.[1]);
  if (!(Number(node.split(".")[0]) >= floor)) {
    throw new Error(`node ${node} is below the package's engines.node ${engines}`);
  }

  const work = mkdtempSync(join(tmpdir(), "sdk-pack-"));
  const outDir = process.env.PACK_OUT_DIR ? resolve(process.env.PACK_OUT_DIR) : join(work, "pack");
  mkdirSync(outDir, { recursive: true });

  let tarball = "";
  step("npm pack", () => {
    const [packed] = JSON.parse(
      run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outDir], SDK)
    ) as { filename: string; files: { path: string }[] }[];
    tarball = join(outDir, packed.filename);
    const problems = checkPackList(packed.files.map((f) => f.path));
    if (problems.length > 0) throw new Error(problems.join("\n"));
  });

  step("publint", () => {
    run("node", [binOf("publint", "publint"), "run", tarball, "--strict"], work);
  });

  step("attw", () => {
    run("node", [binOf("@arethetypeswrong/cli", "attw"), tarball, "--format", "ascii"], work);
  });

  const consumer = join(work, "consumer");
  step("offline install into an empty project", () => {
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "sdk-consumer", private: true, type: "module" })
    );
    run(
      "npm",
      ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      consumer
    );
  });

  step("import and require expose the same working client", () => {
    writeFileSync(join(consumer, "esm.mjs"), CONSUMER_ESM);
    writeFileSync(join(consumer, "cjs.cjs"), CONSUMER_CJS);
    const esm = run("node", ["esm.mjs"], consumer).trim();
    const cjs = run("node", ["cjs.cjs"], consumer).trim();
    if (esm !== cjs) throw new Error(`import and require differ:\n${esm}\n${cjs}`);
    const probe = JSON.parse(esm) as {
      names: string[];
      header: string;
      health: { status: string };
    };
    const version = (
      JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string }
    ).version;
    if (!probe.names.includes("LumenWipeClient") || !probe.names.includes("runClose")) {
      throw new Error(`the entry points are missing exports: ${probe.names.join(", ")}`);
    }
    if (probe.header !== `sdk/${version}` || probe.health.status !== "ok") {
      throw new Error(`the packed client did not round-trip: ${esm}`);
    }
  });

  step(`type-check with the current TypeScript and with ${MINIMUM_TYPESCRIPT}`, () => {
    writeFileSync(join(consumer, "types-esm.mts"), TYPES_ESM);
    writeFileSync(join(consumer, "types-cjs.cts"), TYPES_CJS);
    const config = (name: string, options: Record<string, unknown>, files: string[]): string => {
      writeFileSync(
        join(consumer, name),
        JSON.stringify({ compilerOptions: { ...BASE_OPTIONS, ...options }, files })
      );
      return name;
    };
    const node16 = config(
      "tsconfig.node16.json",
      { module: "node16", moduleResolution: "node16" },
      ["types-esm.mts", "types-cjs.cts"]
    );
    const bundler = config(
      "tsconfig.bundler.json",
      { module: "esnext", moduleResolution: "bundler" },
      ["types-esm.mts"]
    );
    const minimum = binOf("typescript-minimum", "tsc");
    const installed = JSON.parse(
      readFileSync(Bun.resolveSync("typescript-minimum/package.json", SDK), "utf8")
    ) as { version: string };
    if (!installed.version.startsWith(`${MINIMUM_TYPESCRIPT}.`)) {
      throw new Error(
        `typescript-minimum is ${installed.version}, expected ${MINIMUM_TYPESCRIPT}.x`
      );
    }
    const current = binOf("@typescript/native", "tsc");
    for (const project of [node16, bundler]) run("node", [current, "-p", project], consumer);
    run("node", [minimum, "-p", node16], consumer);
  });

  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\n`);
  console.log(`Packed tarball: ${tarball}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
