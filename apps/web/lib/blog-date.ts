/** "November 15, 2026" for "2026-11-15". */
export function formatPostDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-11-15T00:00:00Z" for "2026-11-15": a post date as the UTC timestamp structured data and
 *  Open Graph expect. */
export function postTimestamp(isoDate: string): string {
  return `${isoDate}T00:00:00Z`;
}
