import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The type scale in tailwind.config.ts. Unlisted, tailwind-merge reads `text-caption` as a color
// and drops it next to `text-fg-subtle`.
const TYPE_SCALE = ["caption", "label", "body-sm", "body", "title", "heading", "display", "hero"];

const twMerge = extendTailwindMerge({ extend: { theme: { text: TYPE_SCALE } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
