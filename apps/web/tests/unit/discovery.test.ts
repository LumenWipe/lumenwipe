import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GET as authMd } from "@/app/auth.md/route";
import { GET as skillsIndexRoute } from "@/app/.well-known/agent-skills/index.json/route";
import {
  GET as skillRoute,
  generateStaticParams,
} from "@/app/.well-known/agent-skills/[skill]/SKILL.md/route";
import { GET as aiCatalogRoute } from "@/app/.well-known/ai-catalog.json/route";
import { GET as ardRoute } from "@/app/.well-known/ard.json/route";
import sitemap from "@/app/sitemap";
import {
  AGENT_SKILLS,
  AI_CATALOG_PATH,
  ARD_PATH,
  API_URL,
  AUTH_PATH,
  SKILLS_INDEX_PATH,
  STATUS_URL,
  ardEntries,
  renderArdManifest,
  renderAuthMd,
  renderSkillMarkdown,
  renderSkillsIndex,
  sha256Digest,
  skillPath,
} from "@/lib/site/discovery";
import { renderLlmsTxt } from "@/lib/site/llms";

const REPO = join(import.meta.dir, "../../../..");
const WEB = join(import.meta.dir, "../..");
const read = (path: string): string => readFileSync(join(REPO, path), "utf8");
const DOCS = "https://docs.lumenwipe.com";
const ORIGIN = "https://site.test";

const saved = process.env.NEXT_PUBLIC_APP_URL;
beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = `${ORIGIN}/`;
});
afterEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = `${ORIGIN}/`;
});
afterAll(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = saved;
});

const MEDIA_TYPE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/;
const IDENTIFIER =
  /^urn:air:[a-zA-Z0-9.-]+:[a-zA-Z0-9._~!$&'()*+,;=@/-]+(:[a-zA-Z0-9._~!$&'()*+,;=@/-]+)?$/;

interface Served {
  path: string;
  type: string;
  body: string;
}

async function served(): Promise<Served[]> {
  const get = async (path: string, res: Response | Promise<Response>): Promise<Served> => {
    const r = await res;
    expect(r.status, path).toBe(200);
    return { path, type: r.headers.get("Content-Type") ?? "", body: await r.text() };
  };
  const params = generateStaticParams();
  return [
    await get(AUTH_PATH, authMd()),
    await get(ARD_PATH, ardRoute()),
    await get(AI_CATALOG_PATH, aiCatalogRoute()),
    await get(SKILLS_INDEX_PATH, skillsIndexRoute()),
    ...(await Promise.all(
      params.map((p) =>
        get(
          skillPath(p.skill),
          skillRoute(new Request(`${ORIGIN}${skillPath(p.skill)}`), {
            params: Promise.resolve(p),
          })
        )
      )
    )),
  ];
}

describe("content types", () => {
  test("every discovery file is served with its own type and charset", async () => {
    const types = Object.fromEntries((await served()).map((s) => [s.path, s.type]));
    expect(types).toEqual({
      "/auth.md": "text/markdown; charset=utf-8",
      "/.well-known/ard.json": "application/json; charset=utf-8",
      "/.well-known/ai-catalog.json": "application/json; charset=utf-8",
      "/.well-known/agent-skills/index.json": "application/json; charset=utf-8",
      "/.well-known/agent-skills/analyze-stellar-account/SKILL.md": "text/markdown; charset=utf-8",
      "/.well-known/agent-skills/close-stellar-account/SKILL.md": "text/markdown; charset=utf-8",
      "/.well-known/agent-skills/revoke-token-allowance/SKILL.md": "text/markdown; charset=utf-8",
    });
  });

  test("an unknown skill name is a 404, never a blank skill", async () => {
    const res = await skillRoute(new Request(`${ORIGIN}/x`), {
      params: Promise.resolve({ skill: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  test("every route is prerendered", () => {
    for (const route of [
      "app/auth.md/route.ts",
      "app/.well-known/ard.json/route.ts",
      "app/.well-known/ai-catalog.json/route.ts",
      "app/.well-known/agent-skills/index.json/route.ts",
      "app/.well-known/agent-skills/[skill]/SKILL.md/route.ts",
    ]) {
      expect(readFileSync(join(WEB, route), "utf8"), route).toContain(
        'export const dynamic = "force-static"'
      );
    }
  });
});

describe("the ARD manifest", () => {
  const manifest = () =>
    JSON.parse(renderArdManifest(ORIGIN)) as {
      specVersion: string;
      host: { displayName: string; documentationUrl: string };
      entries: Record<string, unknown>[];
    };

  test("is one document at both paths, byte for byte", async () => {
    const [ard, catalog] = [await ardRoute().text(), await aiCatalogRoute().text()];
    expect(ard).toBe(catalog);
    expect(ard).toBe(renderArdManifest(ORIGIN));
  });

  test("has the AI Catalog 0.9 members and the ARD entries array", () => {
    const m = manifest();
    expect(m.specVersion).toBe("0.9");
    expect(m.host.displayName).toBe("LumenWipe");
    expect(m.host.documentationUrl).toBe(DOCS);
    expect(Array.isArray(m.entries)).toBe(true);
  });

  test("every entry has the terms ARD 0.91 requires, and exactly one of url and data", () => {
    const identifiers = new Set<string>();
    for (const entry of manifest().entries) {
      expect(typeof entry.identifier).toBe("string");
      expect(entry.identifier as string).toMatch(IDENTIFIER);
      expect(entry.identifier as string).toMatch(/^urn:air:lumenwipe\.com:/);
      identifiers.add(entry.identifier as string);
      expect(typeof entry.displayName === "string" && entry.displayName !== "").toBe(true);
      expect(entry.type as string).toMatch(MEDIA_TYPE);
      expect(["url", "data"].filter((k) => k in entry)).toHaveLength(1);
      expect(new URL(entry.url as string).protocol).toBe("https:");
      const queries = entry.representativeQueries as string[];
      expect(queries.length).toBeGreaterThanOrEqual(2);
      expect(queries.length).toBeLessThanOrEqual(5);
      for (const q of queries) expect(q.trim()).not.toBe("");
    }
    expect(identifiers.size).toBe(manifest().entries.length);
  });

  test("lists exactly the four things that exist, each at the type it is served as", () => {
    expect(ardEntries(`${ORIGIN}/`).map((e) => [e.url, e.type])).toEqual([
      [`${API_URL}/docs-json`, "application/json"],
      [DOCS, "text/html"],
      [STATUS_URL, "text/html"],
      [`${ORIGIN}${SKILLS_INDEX_PATH}`, "application/json"],
    ]);
  });

  test("the OpenAPI entry points at the path the API's own catalog names", () => {
    expect(read("apps/api/src/common/discovery-links.ts")).toContain(
      'export const OPENAPI_PATH = "/docs-json";'
    );
  });
});

describe("the agent skills index", () => {
  const index = () =>
    JSON.parse(renderSkillsIndex()) as {
      $schema: string;
      skills: { name: string; type: string; description: string; url: string; digest: string }[];
    };

  test("has the 0.2.0 shape: schema, and per skill name, type, description, url, digest", () => {
    const i = index();
    expect(i.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(i.skills.map((s) => s.name)).toEqual([
      "analyze-stellar-account",
      "close-stellar-account",
      "revoke-token-allowance",
    ]);
    for (const s of i.skills) {
      expect(Object.keys(s).sort()).toEqual(["description", "digest", "name", "type", "url"]);
      expect(s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.name.length).toBeLessThanOrEqual(64);
      expect(s.type).toBe("skill-md");
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.description.length).toBeLessThanOrEqual(1024);
      expect(s.url).toBe(`/.well-known/agent-skills/${s.name}/SKILL.md`);
      expect(s.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("each digest is the sha256 of the exact bytes the SKILL.md route serves", async () => {
    for (const s of index().skills) {
      const res = await skillRoute(new Request(`${ORIGIN}${s.url}`), {
        params: Promise.resolve({ skill: s.name }),
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(s.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    }
    expect(sha256Digest("a")).toBe(
      "sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
    );
  });

  test("each SKILL.md names the skill in its front matter, as the index does", () => {
    for (const skill of AGENT_SKILLS) {
      const text = renderSkillMarkdown(skill);
      const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
      expect(front?.[1]).toBe(skill.name);
      expect(front?.[2]).toBe(skill.description);
      expect(index().skills.find((s) => s.name === skill.name)?.description).toBe(
        skill.description
      );
    }
  });

  test("does not depend on the deployment origin, so a digest cannot drift between builds", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://other.test";
    expect(renderSkillsIndex()).toBe(renderSkillsIndex());
    const other = AGENT_SKILLS.map((s) => renderSkillMarkdown(s));
    process.env.NEXT_PUBLIC_APP_URL = `${ORIGIN}/`;
    expect(AGENT_SKILLS.map((s) => renderSkillMarkdown(s))).toEqual(other);
  });
});

describe("what the skills say is true of the API and the packages", () => {
  const openapi = JSON.parse(read("docs/api-reference/openapi.json")) as {
    paths: Record<string, Record<string, { requestBody?: unknown }>>;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };
  const text = AGENT_SKILLS.map((s) => s.body).join("\n");

  test("every endpoint a skill names exists in the OpenAPI document with that method", () => {
    const found = [
      ...text.matchAll(/\b(GET|POST) (?:https:\/\/api\.lumenwipe\.com)?(\/v1\/[^\s`?]*)/g),
    ];
    expect(found.length).toBeGreaterThanOrEqual(8);
    for (const [, method, path] of found) {
      expect(openapi.paths[path]?.[method!.toLowerCase()], `${method} ${path}`).toBeDefined();
    }
  });

  test("every body field a skill names is a property of that request", () => {
    const fields = (ref: string): string[] =>
      Object.keys(openapi.components.schemas[ref]!.properties ?? {});
    const inline = (path: string): string[] => {
      const body = openapi.paths[path]!.post!.requestBody as {
        content: { "application/json": { schema: { properties?: Record<string, unknown> } } };
      };
      return Object.keys(body.content["application/json"].schema.properties ?? {});
    };
    const expectations: [string, string, string[]][] = [
      ["POST /v1/{network}/close/plan", "{ source, destination }", fields("ClosePlanRequestDto")],
      [
        "POST /v1/{network}/close/transactions",
        "{ source, destination, decisions, planHash }",
        fields("CloseTransactionsRequestDto"),
      ],
      ["POST /v1/{network}/submit", "{ signedXdr }", fields("SubmitRequestDto")],
      [
        "POST /v1/{network}/allowances/revoke",
        "{ owner, token, spender }",
        inline("/v1/{network}/allowances/revoke"),
      ],
    ];
    for (const [call, shape, props] of expectations) {
      expect(text, call).toContain(`\`${call}`);
      expect(text).toContain(shape);
      for (const name of shape
        .replace(/[{}]/g, "")
        .split(",")
        .map((n) => n.trim())) {
        expect(props, `${call} ${name}`).toContain(name);
      }
    }
  });

  test("every SDK method and verifier export a skill names exists", () => {
    const client = read("packages/sdk/src/client.ts");
    for (const method of text.matchAll(/client\.([A-Za-z]+)\(/g)) {
      const declared = [`async ${method[1]}(`, `  ${method[1]}(`].some((d) => client.includes(d));
      expect(declared, method[1]).toBe(true);
    }
    const sdk = read("packages/sdk/src/index.ts");
    expect(sdk).toContain("runClose");
    const verify = read("packages/verify/src/index.ts");
    for (const name of [
      "verifyCloseTransaction",
      "exitExpectations",
      "poolWithdrawalExpectations",
      "verifyRevokeAllowanceTransaction",
      "RevokeAllowanceVerificationError",
      "VerificationError",
    ]) {
      expect(verify, name).toContain(name);
      expect(text, name).toContain(name);
    }
  });

  test("every response field a skill names exists in the shared types", () => {
    const types = read("packages/types/src/close-api.ts");
    for (const field of ["blockers", "decisionPoints", "planHash", "requiresAnotherCall"]) {
      expect(types, field).toContain(field);
      expect(text, field).toContain(field);
    }
    expect(read("packages/types/src/responses.ts")).toMatch(
      /RevokeAllowanceResponse \{\s+transaction: string;/
    );
  });

  test("every skill says a transaction is verified before signing, and that the key stays with the user", () => {
    for (const skill of AGENT_SKILLS.filter((s) => s.name !== "analyze-stellar-account")) {
      expect(skill.body, skill.name).toContain(
        "must be verified with `@lumenwipe/verify` before signing"
      );
    }
    for (const skill of AGENT_SKILLS) {
      expect(skill.body, skill.name).toContain(
        "The API never holds or receives the private key of the account."
      );
    }
  });
});

describe("auth.md", () => {
  const limits = read("docs/integrators/limits.mdx");
  const auth = renderAuthMd(ORIGIN);
  const docsAuth = read("docs/api-reference/introduction.mdx");

  test("states the numbers the limits page states", () => {
    const row = (name: string): string =>
      new RegExp(`\\| ${name}\\s+\\| ([^|]+?)\\s+\\|`).exec(limits)![1]!;
    expect(row("Default request rate")).toBe("120 requests per 60 seconds, per API key");
    expect(auth).toContain("120 requests per 60 seconds per API key");
    expect(auth).toContain(`${row("Active keys per wallet")} active keys per wallet`);
    expect(auth).toContain(`up to ${row("JSON request body")}`);
  });

  test("describes the sign-in and the key as the API reference does", () => {
    for (const phrase of [
      "Varial (formerly Freighter), xBull or Hana",
      "SEP-53",
      "The key is shown once",
    ]) {
      expect(docsAuth).toContain(phrase);
    }
    expect(auth).toContain("Varial (formerly Freighter), xBull or Hana");
    expect(auth).toContain("one-time SEP-53 message, not a transaction");
    expect(auth).toContain("It is shown once.");
    expect(auth).toContain("Authorization: Bearer <your key>");
    expect(docsAuth).toContain("Authorization: Bearer $LUMENWIPE_API_KEY");
  });

  test("says the network limit is optional, and that the API uses keys, not OAuth", () => {
    expect(auth).toContain("Optionally give the key a label and limit it to mainnet or testnet");
    expect(docsAuth).toContain(
      "Optionally give the key a label and limit it to mainnet or testnet"
    );
    expect(auth).toContain("does not use OAuth");
    expect(auth).toContain(
      "`GET /`, the health routes and `GET /v1/config/exchange-registry` need no key."
    );
  });

  test("links the API keys page on this site's origin", () => {
    expect(auth).toContain(`${ORIGIN}/api-keys`);
    expect(existsSync(join(WEB, "app/(app)/api-keys/page.tsx"))).toBe(true);
  });
});

describe("every link resolves", () => {
  const sluggify = (heading: string): string =>
    heading
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, "")
      .trim()
      .replace(/ +/g, "-");

  test("docs links name a page that exists, and an anchor that is one of its headings", async () => {
    const urls = (await served())
      .flatMap((s) => [...s.body.matchAll(/https:\/\/docs\.lumenwipe\.com[^\s)>"`]*[^\s)>"`.,]/g)])
      .map((m) => m[0]);
    urls.push(
      ...ardEntries(ORIGIN)
        .map((e) => e.url)
        .filter((u) => new URL(u).origin === DOCS)
    );
    expect(urls.length).toBeGreaterThan(10);
    const nav = read("docs/docs.json");
    for (const url of new Set(urls)) {
      const { pathname, hash } = new URL(url);
      if (pathname === "/") continue;
      const file = [`docs${pathname}.mdx`, `docs${pathname}.md`].find((f) =>
        existsSync(join(REPO, f))
      );
      expect(file, url).toBeDefined();
      expect(nav, url).toContain(`"${pathname.slice(1)}"`);
      if (hash) {
        const headings = [...read(file!).matchAll(/^#{1,6} (.+)$/gm)].map((m) => sluggify(m[1]!));
        expect(headings, url).toContain(hash.slice(1));
      }
    }
  });

  test("links to this site are files this site serves", async () => {
    const files = await served();
    const known = new Set([...files.map((f) => `${ORIGIN}${f.path}`), `${ORIGIN}/api-keys`]);
    const llms = renderLlmsTxt(ORIGIN);
    const urls = [...files.map((f) => f.body), llms, renderArdManifest(ORIGIN)]
      .flatMap((b) => [...b.matchAll(/https:\/\/site\.test[^\s)>"`]*[^\s)>"`.,]/g)])
      .map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      if (/\/(security|how-it-works|faq|blog)/.test(url)) continue;
      expect(known.has(url), url).toBe(true);
    }
  });

  test("the skills index points at each SKILL.md the route builds", async () => {
    const paths = generateStaticParams().map((p) => skillPath(p.skill));
    const urls = (JSON.parse(renderSkillsIndex()) as { skills: { url: string }[] }).skills.map(
      (s) => s.url
    );
    expect(urls).toEqual(paths);
  });

  test("no other host appears than this site, the docs, the API and the status page", async () => {
    const hosts = new Set<string>();
    for (const file of await served()) {
      for (const m of file.body.matchAll(/https?:\/\/([a-z0-9.-]+)/g)) hosts.add(m[1]!);
    }
    expect([...hosts].sort()).toEqual(
      [
        "api.lumenwipe.com",
        "docs.lumenwipe.com",
        "schemas.agentskills.io",
        "site.test",
        "status.lumenwipe.com",
      ].sort()
    );
  });

  test("llms.txt links the three discovery entry points", () => {
    const llms = renderLlmsTxt(ORIGIN);
    expect(llms).toContain(`(${ORIGIN}/auth.md)`);
    expect(llms).toContain(`(${ORIGIN}${SKILLS_INDEX_PATH})`);
    expect(llms).toContain(`(${ORIGIN}${ARD_PATH})`);
  });

  test("the sitemap lists pages, not these files", () => {
    for (const entry of sitemap()) {
      expect(entry.url).not.toMatch(/auth\.md|\.well-known|llms\.txt/);
    }
  });
});

describe("only what is true", () => {
  test("no file claims an auth scheme or card the site does not serve, or any commercial or planning language", async () => {
    const all = (await served()).map((s) => s.body).join("\n");
    expect(all.match(/OAuth/g)).toHaveLength(1);
    for (const word of [
      /\bMCP\b/,
      /\bA2A\b/,
      /agent card/i,
      /openid/i,
      /\bgrants?\b/i,
      /tranche/i,
      /\bSCF\b/,
      /partner/i,
      /funding|investor|\$\d/i,
      /roadmap|planned|coming soon/i,
    ]) {
      expect(all, String(word)).not.toMatch(word);
    }
  });

  test("no file contains an em dash or an AI attribution", async () => {
    const dash = String.fromCharCode(0x2014);
    for (const file of await served()) {
      expect(file.body, file.path).not.toContain(dash);
      expect(file.body, file.path).not.toMatch(/claude|anthropic|generated (by|with)/i);
    }
  });
});
