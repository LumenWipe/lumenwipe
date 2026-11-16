/**
 * Prints a GitHub Actions warning for every contract registry entry last verified more than
 * ENTRY_STALE_DAYS days ago. A stale entry is a warning and exits 0; a registry that cannot be
 * read or does not validate throws on import and exits non-zero.
 *
 *   bun run --filter '@lumenwipe/api' registry:staleness
 */
import { servedContractRegistry, staleEntryWarnings } from "@/lib/contract-registry";

const warnings = staleEntryWarnings(servedContractRegistry());
for (const line of warnings) console.log(line);
console.log(`${warnings.length} contract registry entries need re-verification.`);
