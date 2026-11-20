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
