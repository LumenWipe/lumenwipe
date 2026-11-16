import type { Metadata } from "next";

// The page is a client component and cannot export metadata, so its title is set here, on the
// server, where the root layout's template turns it into "Close result | LumenWipe".
// The server cannot know how the close ended, so this title stays neutral; CompletionReceipt
// replaces it at runtime with "Account closed" or "Close incomplete" once the outcome is known.
export const metadata: Metadata = {
  title: "Close result",
};

export default function CompleteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
