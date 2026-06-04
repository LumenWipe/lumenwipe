"use client";

import { useEffect, useState } from "react";

type TocEntry = { id: string; text: string; level: number };

/**
 * "On this page" table of contents with a scroll-spy that highlights the
 * section the reader is currently in. Progressive enhancement: the links
 * navigate fine without JS; the active highlight is a JS-only addition.
 */
export default function BlogToc({ toc }: { toc: TocEntry[] }) {
  const [active, setActive] = useState<string | null>(toc[0]?.id ?? null);

  useEffect(() => {
    if (!toc.length) return;
    let raf = 0;

    const compute = () => {
      raf = 0;
      // Offset clears the sticky header (h-16) plus the headings' scroll-mt.
      const offset = 100;
      let current = toc[0].id;
      for (const entry of toc) {
        const el = document.getElementById(entry.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= offset) current = entry.id;
        else break;
      }
      setActive(current);
    };

    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };

    compute();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [toc]);

  if (!toc.length) return null;

  return (
    <aside className="hidden lg:block w-52 flex-shrink-0">
      <div className="sticky top-24">
        <p className="mkt-eyebrow text-white/40 mb-3">On this page</p>
        <nav>
          <ul className="border-l border-white/10">
            {toc.map((entry) => {
              const isActive = active === entry.id;
              return (
                <li key={entry.id}>
                  <a
                    href={`#${entry.id}`}
                    aria-current={isActive ? "location" : undefined}
                    className={`-ml-px block border-l-2 py-1 text-xs leading-snug transition-colors ${
                      entry.level === 3 ? "pl-6" : "pl-3"
                    } ${
                      isActive
                        ? "border-stellar text-stellar"
                        : "border-transparent text-white/45 hover:text-white/80"
                    }`}
                  >
                    {entry.text}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </aside>
  );
}
