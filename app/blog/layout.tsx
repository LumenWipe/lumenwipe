import Link from "next/link";
import { Zap } from "lucide-react";

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link
            href="/public"
            className="flex items-center gap-2 text-foreground hover:text-stellar transition-colors"
          >
            <Zap className="h-5 w-5 text-stellar" />
            <span className="font-semibold text-sm tracking-tight">LumenWipe</span>
            <span className="text-muted-foreground text-sm">/</span>
            <span className="text-sm text-muted-foreground">Blog</span>
          </Link>

          <Link
            href="/public"
            className="text-xs font-medium px-3 py-1.5 rounded border border-stellar/30 text-stellar hover:bg-stellar/10 transition-colors"
          >
            Launch App
          </Link>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border mt-16">
        <div className="max-w-5xl mx-auto px-4 py-6 flex items-center justify-between text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} LumenWipe</span>
          <Link href="/blog" className="hover:text-foreground transition-colors">
            All articles
          </Link>
        </div>
      </footer>
    </div>
  );
}
