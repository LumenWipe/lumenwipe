import type { Category } from "@/lib/blog";
import { Badge } from "@/components/ui/badge";
import type { Locale } from "@/lib/i18n/locale";
import { BLOG } from "@/lib/i18n/messages/blog";

const tones = {
  Technical: "accent",
  Updates: "warning",
  Guides: "success",
} as const satisfies Record<Category, "accent" | "warning" | "success">;

export default function CategoryBadge({
  category,
  locale,
}: {
  category: Category;
  locale: Locale;
}) {
  return <Badge tone={tones[category]}>{BLOG[locale].categories[category]}</Badge>;
}
