import { getAllSlugs } from "@/lib/blog";
import { SPANISH_PAGES, type SpanishPage } from "@/lib/site/pages";

/** Every English page with a Spanish version: the pages `SPANISH_PAGES` lists, and each post
 *  translated under `content/blog/es`, at its English slug. Server only, since it reads the posts
 *  from disk: a client component is given this list as a prop. */
export function spanishPages(): SpanishPage[] {
  return [
    ...SPANISH_PAGES,
    ...getAllSlugs("es").map((slug) => ({ path: `/blog/${slug}`, translated: true })),
  ];
}
