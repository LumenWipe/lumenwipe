import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkPins, readInputs, type PinInputs } from "./check-image-pins";

const D = (n: string) => n.repeat(64);
const SYNTAX = `# syntax=docker/dockerfile:1.27.1@sha256:${D("a")}`;
const BUN = `FROM oven/bun:1.4.4@sha256:${D("b")} AS builder`;
const NODE = `FROM node:26.13.1-slim@sha256:${D("c")} AS runtime`;

const inputs = (over: Partial<PinInputs> = {}): PinInputs => ({
  dockerfile: [SYNTAX, BUN, "RUN bun install", NODE, "COPY --from=builder /app /app"].join("\n"),
  toolVersions: "nodejs 26.13.1\nbun 1.4.4\n",
  workflows: { "ci.yml": "        with:\n          bun-version: 1.4.4\n" },
  ...over,
});

const withDockerfile = (lines: string[]) => inputs({ dockerfile: lines.join("\n") });

describe("check-image-pins", () => {
  test("the pinned Dockerfile passes", () => {
    expect(checkPins(inputs())).toEqual([]);
  });

  test("the repository's own Dockerfile, .tool-versions and workflows pass", () => {
    expect(checkPins(readInputs(join(import.meta.dir, "..")))).toEqual([]);
  });

  test("an unpinned FROM fails", () => {
    const errors = checkPins(withDockerfile([SYNTAX, BUN, "FROM node:26-slim AS runtime"]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("node:26-slim is not pinned");
  });

  test("a digest without its tag fails", () => {
    const errors = checkPins(withDockerfile([SYNTAX, BUN, `FROM node@sha256:${D("c")}`]));
    expect(errors[0]).toContain("is not pinned");
  });

  test("a digest of the wrong length fails", () => {
    for (const digest of [D("c").slice(1), `${D("c")}0`, D("C")]) {
      const errors = checkPins(
        withDockerfile([SYNTAX, BUN, `FROM node:26.13.1-slim@sha256:${digest} AS runtime`])
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("is not pinned");
    }
  });

  test("an unpinned or missing syntax frontend fails", () => {
    expect(checkPins(withDockerfile(["# syntax=docker/dockerfile:1", BUN, NODE]))[0]).toContain(
      "docker/dockerfile:1 is not pinned"
    );
    expect(checkPins(withDockerfile([BUN, NODE]))[0]).toContain("no pinned `# syntax=` line");
  });

  test("a Bun image that is not the Bun in .tool-versions fails", () => {
    const errors = checkPins(
      withDockerfile([SYNTAX, `FROM oven/bun:1.4.3@sha256:${D("b")} AS builder`, NODE])
    );
    expect(errors).toEqual([
      "apps/api/Dockerfile:2: oven/bun:1.4.3 is not the Bun in .tool-versions (1.4.4)",
    ]);
  });

  test("a Node image that is not the Node in .tool-versions fails", () => {
    const errors = checkPins(
      withDockerfile([SYNTAX, BUN, `FROM node:26.13.0-slim@sha256:${D("c")} AS runtime`])
    );
    expect(errors).toEqual([
      "apps/api/Dockerfile:3: node:26.13.0-slim is not the Node in .tool-versions (26.13.1)",
    ]);
  });

  test("a workflow Bun pin that disagrees with .tool-versions fails", () => {
    const errors = checkPins(
      inputs({
        workflows: {
          "ci.yml": '          bun-version: "1.4.3"\n',
          "e2e.yml": "      - run: npm install -g bun@1.4.2\n",
        },
      })
    );
    expect(errors).toEqual([
      ".github/workflows/ci.yml:1: Bun 1.4.3 is not the Bun in .tool-versions (1.4.4)",
      ".github/workflows/e2e.yml:1: Bun 1.4.2 is not the Bun in .tool-versions (1.4.4)",
    ]);
  });

  test("FROM an earlier stage is not a registry image and needs no digest", () => {
    expect(checkPins(withDockerfile([SYNTAX, BUN, "FROM builder AS test", NODE]))).toEqual([]);
  });

  test("a .tool-versions without bun or nodejs fails", () => {
    expect(checkPins(inputs({ toolVersions: "" }))).toEqual([
      ".tool-versions has no bun version",
      ".tool-versions has no nodejs version",
    ]);
  });
});
