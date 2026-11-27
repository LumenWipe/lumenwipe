import { AGENT_SKILLS, renderSkillMarkdown } from "@/lib/site/discovery";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams(): { skill: string }[] {
  return AGENT_SKILLS.map((skill) => ({ skill: skill.name }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ skill: string }> }
): Promise<Response> {
  const { skill: name } = await params;
  const skill = AGENT_SKILLS.find((s) => s.name === name);
  if (!skill) return new Response("Not found", { status: 404 });
  return new Response(renderSkillMarkdown(skill), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
