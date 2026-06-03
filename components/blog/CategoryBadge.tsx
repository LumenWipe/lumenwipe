import type { Category } from "@/lib/blog";

const styles: Record<Category, string> = {
  Technical: "bg-stellar/10 text-stellar border-stellar/20",
  Updates: "bg-amber-400/10 text-amber-400 border-amber-400/20",
  Guides: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20",
};

export default function CategoryBadge({ category }: { category: Category }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${styles[category]}`}
    >
      {category}
    </span>
  );
}
