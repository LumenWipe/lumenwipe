"use client";

import { useEffect, useState } from "react";

interface StatusMessageProps {
  message: string;
}

// The region is rendered empty first and filled after mount: screen readers announce changes
// inside a live region, not a region inserted already holding its text.
export default function StatusMessage({ message }: StatusMessageProps) {
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    setAnnounced(message);
  }, [message]);
  return (
    <p role="status" className="sr-only">
      {announced}
    </p>
  );
}
