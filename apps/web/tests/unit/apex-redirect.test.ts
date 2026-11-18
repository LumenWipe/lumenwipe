import { expect, test } from "bun:test";
import { PHASE_PRODUCTION_SERVER } from "next/constants.js";
import config from "@/next.config.mjs";
import { resolveHeaders, resolveRedirect } from "../next-routing";

const nextConfig = config(PHASE_PRODUCTION_SERVER);
const redirect = async (host: string, url: string) =>
  resolveRedirect(await nextConfig.redirects!(), { host, url });

test("apex redirect › every path on the apex goes to the same path on www with a 308", async () => {
  const home = await redirect("lumenwipe.com", "/");
  expect(home?.status).toBe(308);
  expect(new URL(home!.location).href).toBe("https://www.lumenwipe.com/");
  expect(await redirect("lumenwipe.com", "/blog/phase-2-launch")).toEqual({
    status: 308,
    location: "https://www.lumenwipe.com/blog/phase-2-launch",
  });
  expect(await redirect("lumenwipe.com", "/api/v1/plan")).toEqual({
    status: 308,
    location: "https://www.lumenwipe.com/api/v1/plan",
  });
});

test("apex redirect › the query is kept", async () => {
  expect(await redirect("lumenwipe.com", "/faq?x=1&utm_source=a%20b")).toEqual({
    status: 308,
    location: "https://www.lumenwipe.com/faq?x=1&utm_source=a%20b",
  });
});

test("apex redirect › the host is matched without its port and in any letter case", async () => {
  expect((await redirect("LumenWipe.COM:443", "/faq"))?.location).toBe(
    "https://www.lumenwipe.com/faq"
  );
});

test("apex redirect › www, preview and look-alike hosts are not redirected", async () => {
  for (const host of [
    "www.lumenwipe.com",
    "lumenwipe-git-main-acachete-labs.vercel.app",
    "lumenwipexcom",
    "lumenwipe.com.example.org",
    "localhost:3000",
  ]) {
    expect(await redirect(host, "/faq")).toBeNull();
  }
  expect(await redirect("www.lumenwipe.com", "/public/x?q=1")).toEqual({
    status: 308,
    location: "/mainnet/x?q=1",
  });
});

test("apex redirect › the redirect response carries HSTS with includeSubDomains, no preload", async () => {
  const headers = resolveHeaders(await nextConfig.headers!(), {
    host: "lumenwipe.com",
    url: "/faq?x=1",
  });
  expect(headers["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains");
});
