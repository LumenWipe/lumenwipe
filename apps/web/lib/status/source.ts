/** The status host the banner reads, from `STATUS_SOURCE_URL`. Null when it is unset or not https. */
export function statusSource(): URL | null {
  const raw = process.env.STATUS_SOURCE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The status page readers are sent to: the status host's origin, as the banner links it. Null
 *  when no status source is configured. */
export function statusPageUrl(): string | null {
  return statusSource()?.origin ?? null;
}
