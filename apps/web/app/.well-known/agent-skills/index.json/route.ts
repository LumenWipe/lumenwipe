import { renderSkillsIndex } from "@/lib/site/discovery";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(renderSkillsIndex(), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
