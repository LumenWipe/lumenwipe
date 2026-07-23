"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Stagger delay in ms applied to the reveal transition. */
  delay?: number;
  as?: "div" | "li" | "section";
}

/**
 * Scroll-reveal wrapper built as progressive enhancement: content renders
 * visible by default (so no-JS clients, crawlers, and SSR always see it).
 * Only when JS runs do below-the-fold elements get hidden and then animated
 * back in on scroll, with a grace timer so nothing can stay hidden.
 */
export default function Reveal({ children, className = "", delay = 0, as = "div" }: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    // Above or inside the fold at load: keep it visible, no entrance flash.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.95) return;

    // Below the fold: hide, then animate in when scrolled into view.
    setHidden(true);
    let grace = 0;
    const reveal = () => {
      setHidden(false);
      obs.disconnect();
      if (grace) clearTimeout(grace);
    };
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) reveal();
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
    );
    obs.observe(el);
    // Safety net: reveal even if a scroll/intersection event never arrives.
    grace = window.setTimeout(reveal, 1600);

    return () => {
      obs.disconnect();
      if (grace) clearTimeout(grace);
    };
  }, []);

  const Tag = as as "div";
  return (
    <Tag
      ref={ref as React.RefObject<HTMLDivElement>}
      className={`mkt-reveal ${hidden ? "is-hidden" : ""} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}
