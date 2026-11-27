import { renderArdManifest } from "@/lib/site/discovery";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(renderArdManifest(), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
