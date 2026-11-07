/** An address as the close screens show it: the first and last eight characters. */
export function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

/** A transaction hash as the close screens show it: the first and last six characters. */
export function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-6)}`;
}
