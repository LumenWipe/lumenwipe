/**
 * The public keys a signed exchange registry is verified against. Either one verifies, so the
 * second is a backup, not a quorum. The secrets are held offline by maintainers and never on the
 * API host. Rotation is a release that drops a key from this list; `docs/security-scope.md`
 * lists the same keys and a test fails when the two disagree.
 */
export const REGISTRY_SIGNING_KEYS: readonly string[] = [
  "GAKGKRCTIPJIFS4UAL6TZEXW3ZUUYBFBPBAVNG37NKILQQ5ZSW3VGDTK",
  "GAOXVNB4UHWUOXDLSQXTPUJUZWRHKO35ZP5P5XZNPESMEIPUL3X66PDD",
];
