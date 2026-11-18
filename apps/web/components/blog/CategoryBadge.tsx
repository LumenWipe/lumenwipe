import type { Category } from "@/lib/blog";
import { Badge } from "@/components/ui/badge";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { BLOG } from "@/lib/i18n/messages/blog";

const tones = {
  Technical: "accent",
  Updates: "warning",
  Guides: "success",
} as const satisfies Record<Category, "accent" | "warning" | "success">;

export default function CategoryBadge({ category }: { category: Category }) {
  return <Badge tone={tones[category]}>{BLOG[SITE_LOCALE].categories[category]}</Badge>;
}
