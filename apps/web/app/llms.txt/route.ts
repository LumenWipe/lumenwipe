import { renderLlmsTxt } from "@/lib/site/llms";

export const dynamic = "force-static";

function siteOrigin(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function GET(): Response {
  return new Response(renderLlmsTxt(siteOrigin()), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
