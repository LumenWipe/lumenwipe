import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { within } from "@testing-library/react";
import LandingPage, { metadata as landingMeta } from "@/app/(marketing)/page";
import SecurityPage, { metadata as securityMeta } from "@/app/(marketing)/security/page";
import HowItWorksPage, { metadata as howMeta } from "@/app/(marketing)/how-it-works/page";
import FaqPage, { metadata as faqMeta } from "@/app/(marketing)/faq/page";
import SpanishLandingPage, { metadata as esLandingMeta } from "@/app/(marketing-es)/es/page";
import SpanishSecurityPage, {
  metadata as esSecurityMeta,
} from "@/app/(marketing-es)/es/security/page";
import SpanishFaqPage, { metadata as esFaqMeta } from "@/app/(marketing-es)/es/faq/page";
import SpanishHowItWorksPage, {
  metadata as esHowMeta,
} from "@/app/(marketing-es)/es/how-it-works/page";
import { GET } from "@/app/llms.txt/route";
import HeroConsole from "@/components/marketing/HeroConsole";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import { renderLlmsTxt } from "@/lib/site/llms";
import { FEATURES, PROTOCOLS, STATUS_LABEL } from "@/lib/site/status";
import {
  CHECK_STATEMENT,
  KEY_STATEMENT,
  SERVER_KEYS,
  SERVER_KEYS_INTRO,
  serverKeys,
  serverKeyScope,
  trustStatements,
  VERIFY_SOURCE_URL,
} from "@/lib/site/trust";
import { renderMarketing } from "./fixtures/marketing";

const WEB = join(import.meta.dir, "..", "..");
const ROOT = join(WEB, "..", "..");

// Absolutes the architecture contradicts: the API builds every transaction, two server keys sign,
// and the relay account is one shared account whose key the API holds.
const OVERCLAIMS = [
  /\b0 servers\b/i,
  /read-only backend/i,
  /backend is read-only/i,
  /never in the signing path/i,
  /no backend holds/i,
  /built and signed in your browser/i,
  /can never move your funds/i,
  /signed entirely in your browser/i,
  /its (one|only) (signing )?key/i,
  /single-use/i,
  /generated in (your )?browser/i,
];

// The same absolutes as a Spanish page would put them.
const SPANISH_OVERCLAIMS = [
  /\b0 servidores\b/i,
  /backend de solo lectura/i,
  /nunca (está )?en (la ruta|el camino) de (la )?firma/i,
  /ningún backend (tiene|guarda)/i,
  /(armad|construid)[ao]s? y firmad[ao]s? en tu navegador/i,
  /nunca puede mover tus fondos/i,
  /firmad[ao]s? (por completo|enteramente|completamente) en tu navegador/i,
  /su (única|sola) clave/i,
  /de un solo uso/i,
  /generad[ao] en (tu )?navegador/i,
];

function overclaims(text: string, patterns: readonly RegExp[] = OVERCLAIMS): string[] {
  return patterns.filter((re) => re.test(text)).map(String);
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ");
}

const PAGES = {
  landing: <LandingPage />,
  security: <SecurityPage />,
  howItWorks: <HowItWorksPage />,
  faq: <FaqPage />,
  heroConsole: <HeroConsole />,
  footer: <MarketingFooter locale="en" />,
};

describe("no surface overstates the trust model", () => {
  for (const [name, page] of Object.entries(PAGES)) {
    test(`${name} renders no absolute custody claim`, () => {
      expect(overclaims(renderMarketing(page).textContent ?? "")).toEqual([]);
    });
  }

  test("page metadata and the structured data make none", () => {
    for (const meta of [landingMeta, securityMeta, howMeta, faqMeta]) {
      expect(overclaims(String(meta.description))).toEqual([]);
    }
    for (const file of [
      ["app", "root-document.tsx"],
      ["lib", "site", "root-metadata.ts"],
      ["lib", "i18n", "messages", "site.ts"],
      ["lib", "site", "structured-data.ts"],
    ]) {
      expect(overclaims(readFileSync(join(WEB, ...file), "utf8"))).toEqual([]);
    }
  });

  test("llms.txt and the README make none", () => {
    expect(overclaims(renderLlmsTxt(""))).toEqual([]);
    expect(overclaims(readFileSync(join(ROOT, "README.md"), "utf8"))).toEqual([]);
  });
});

describe("no Spanish surface overstates the trust model", () => {
  const pages = {
    landing: <SpanishLandingPage />,
    security: <SpanishSecurityPage />,
    howItWorks: <SpanishHowItWorksPage />,
    faq: <SpanishFaqPage />,
    footer: <MarketingFooter locale="es" />,
  };
  for (const [name, page] of Object.entries(pages)) {
    test(`${name} renders no absolute custody claim`, () => {
      expect(overclaims(renderMarketing(page).textContent ?? "", SPANISH_OVERCLAIMS)).toEqual([]);
    });
  }

  test("page metadata and the dictionaries make none", () => {
    for (const meta of [esLandingMeta, esSecurityMeta, esHowMeta, esFaqMeta]) {
      expect(overclaims(String(meta.description), SPANISH_OVERCLAIMS)).toEqual([]);
    }
    for (const file of ["site.ts", "security.tsx", "how-it-works.tsx", "faq.tsx", "landing.tsx"]) {
      const source = readFileSync(join(WEB, "lib", "i18n", "messages", file), "utf8");
      expect(overclaims(source, SPANISH_OVERCLAIMS)).toEqual([]);
    }
  });
});

describe("the security page states the trust model precisely", () => {
  test("it carries the key and check statements and names and scopes both server keys", () => {
    const root = renderMarketing(<SecurityPage />);
    const text = squash(root.textContent ?? "");
    expect(text).toContain(KEY_STATEMENT);
    expect(text).toContain(CHECK_STATEMENT);
    expect(text).toContain(SERVER_KEYS_INTRO);
    expect(SERVER_KEYS.map((k) => k.name)).toEqual(["Relay account key", "Fee-sponsor key"]);
    for (const key of SERVER_KEYS) {
      const term = within(root).getByText(key.name);
      const detail = squash(term.nextElementSibling?.textContent ?? "");
      expect(detail).toContain(key.statement);
      expect(detail).toContain(serverKeyScope(key));
    }
  });

  test("it links to the browser check in the repository", () => {
    const root = renderMarketing(<SecurityPage />);
    const link = within(root).getByRole("link", { name: /verify\.ts/ });
    expect(link.getAttribute("href")).toBe(VERIFY_SOURCE_URL);
    expect(VERIFY_SOURCE_URL).toBe(
      "https://github.com/LumenWipe/lumenwipe/blob/main/apps/web/lib/stellar/verify.ts"
    );
    expect(existsSync(join(WEB, "lib", "stellar", "verify.ts"))).toBe(true);
  });

  test("in Spanish, it carries the same statements and server keys, from the same data", () => {
    const root = renderMarketing(<SpanishSecurityPage />);
    const text = squash(root.textContent ?? "");
    const trust = trustStatements("es");
    expect(trust.key).not.toBe(KEY_STATEMENT);
    expect(text).toContain(trust.key);
    expect(text).toContain(trust.check);
    expect(text).toContain(trust.serverKeysIntro);
    const keys = serverKeys("es");
    expect(keys.map((k) => k.feature)).toEqual(SERVER_KEYS.map((k) => k.feature));
    for (const key of keys) {
      const term = within(root).getByText(key.name);
      const detail = squash(term.nextElementSibling?.textContent ?? "");
      expect(detail).toContain(key.statement);
      expect(detail).toContain(serverKeyScope(key, "es"));
    }
    const link = within(root).getByRole("link", { name: /verify\.ts/ });
    expect(link.getAttribute("href")).toBe(VERIFY_SOURCE_URL);
  });

  test("the FAQ answer carries the same statements and link", () => {
    const root = renderMarketing(<FaqPage />);
    const text = squash(root.textContent ?? "");
    for (const s of [KEY_STATEMENT, CHECK_STATEMENT, ...SERVER_KEYS.map((k) => k.statement)]) {
      expect(text).toContain(s);
    }
    const links = within(root).getAllByRole("link", { name: /verify\.ts/, hidden: true });
    expect(links.map((l) => l.getAttribute("href"))).toContain(VERIFY_SOURCE_URL);
  });
});

describe("/llms.txt", () => {
  const saved = process.env.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = saved;
  });

  test("is generated by a route, not served from a static file", () => {
    expect(existsSync(join(WEB, "public", "llms.txt"))).toBe(false);
  });

  test("serves plain text with the trust statements and every status from the registry", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://site.test/";
    const res = GET();
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    for (const s of [KEY_STATEMENT, CHECK_STATEMENT, SERVER_KEYS_INTRO, VERIFY_SOURCE_URL]) {
      expect(body).toContain(s);
    }
    for (const key of SERVER_KEYS) expect(body).toContain(key.statement);
    for (const f of FEATURES) expect(body).toContain(`- ${f.title} (${STATUS_LABEL[f.status]})`);
    for (const p of PROTOCOLS) expect(body).toContain(`- ${p.name}: ${STATUS_LABEL[p.status]}`);
    expect(body).toContain("[Security](https://site.test/security)");
    expect(body).toContain("(https://docs.lumenwipe.com/api-reference/introduction)");
    expect(body).not.toContain("site.test//");
  });
});
