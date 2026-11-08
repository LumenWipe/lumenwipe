const SLASH = 0x2f;

/** `url` without its trailing `/` characters. A linear scan, so a long run of slashes in a
 *  caller's `baseUrl` costs one pass rather than a backtracking regex. */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === SLASH) end--;
  return url.slice(0, end);
}
