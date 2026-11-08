// Loaded into the local API process with `node --import`. Node strips the types, so this file and
// what it imports stay free of syntax that needs compiling.
import { appendFileSync } from "node:fs";
import { spanLabel, type UpstreamKind } from "./span-label.ts";

const spansFile = process.env.LUMENWIPE_LAB_SPANS;
const upstreams = JSON.parse(process.env.LUMENWIPE_LAB_UPSTREAMS ?? "{}") as Record<
  string,
  UpstreamKind
>;

function hrefOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

if (spansFile) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const start = performance.timeOrigin + performance.now();
      const label = spanLabel(
        hrefOf(input),
        typeof init?.body === "string" ? init.body : undefined,
        upstreams
      );
      try {
        return await realFetch(input, init);
      } finally {
        const end = performance.timeOrigin + performance.now();
        appendFileSync(spansFile, `${JSON.stringify({ label, start, end })}\n`);
      }
    },
    realFetch
  );
}
