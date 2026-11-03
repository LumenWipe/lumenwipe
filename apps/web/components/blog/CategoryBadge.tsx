import type { Category } from "@/lib/blog";
import { Badge } from "@/components/ui/badge";

const tones = {
  Technical: "accent",
  Updates: "warning",
  Guides: "success",
} as const satisfies Record<Category, "accent" | "warning" | "success">;

export default function CategoryBadge({ category }: { category: Category }) {
  return <Badge tone={tones[category]}>{category}</Badge>;
}
