"use client";

import { useEffect, useState } from "react";

// Rendered empty first and filled after mount: screen readers announce a change inside a live
// region, not a region inserted already holding its text.
export default function LiveStatus({ message }: { message: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(id);
  }, []);
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {mounted ? message : ""}
    </p>
  );
}
