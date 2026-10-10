const SIGNING_SEGMENTS = new Set(["review", "execute", "complete"]);

export function isSigningRoute(pathname: string): boolean {
  return SIGNING_SEGMENTS.has(pathname.split("/")[2] ?? "");
}
