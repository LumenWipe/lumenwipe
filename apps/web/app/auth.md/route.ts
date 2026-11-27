import { renderAuthMd } from "@/lib/site/discovery";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(renderAuthMd(), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
