import { renderLlmsTxt } from "@/lib/site/llms";
import { siteOrigin } from "@/lib/site/url";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(renderLlmsTxt(siteOrigin()), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
