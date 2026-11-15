import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { ContentStatusRow } from "@/lib/site/content-status";
import { formatPostDate } from "@/lib/blog-date";

const STATUS = {
  published: { label: "Published", tone: "success" },
  planned: { label: "Planned", tone: "neutral" },
} as const;

/** Which articles are out and which are planned. */
export default function ContentStatusTable({ rows }: { rows: readonly ContentStatusRow[] }) {
  return (
    <div className="mkt-panel overflow-x-auto rounded-2xl">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Published and planned articles</caption>
        <thead>
          <tr className="border-b border-white/10 mkt-mono text-caption uppercase tracking-wider text-fg-subtle">
            <th scope="col" className="px-4 py-3 font-medium">
              Article
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Status
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Published
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.title} className="border-b border-white/[0.07] last:border-0">
              <th scope="row" className="px-4 py-3 font-normal text-white/85">
                {row.href ? (
                  <Link href={row.href} className="text-accent hover:underline">
                    {row.title}
                  </Link>
                ) : (
                  row.title
                )}
              </th>
              <td className="px-4 py-3">
                <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
              </td>
              <td className="px-4 py-3 mkt-mono text-xs text-fg-muted whitespace-nowrap">
                {row.publishedAt ? (
                  <time dateTime={row.publishedAt}>{formatPostDate(row.publishedAt)}</time>
                ) : (
                  "Not yet"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
