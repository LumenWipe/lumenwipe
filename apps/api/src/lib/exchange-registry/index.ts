import registry from "@/config/exchange-registry.json";

interface RegistryEntry {
  address: string;
  name: string;
  domain: string;
  requiresMediator: boolean;
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash";
}

const entries = registry.entries as RegistryEntry[];
const byAddress = new Map(entries.map((e) => [e.address, e]));

export function lookupExchange(address: string): RegistryEntry | null {
  return byAddress.get(address) ?? null;
}

export function isCexAddress(address: string): boolean {
  return byAddress.has(address);
}

export function requiresMediatorForAddress(address: string): boolean {
  return byAddress.get(address)?.requiresMediator ?? false;
}

export function getMemoRequirement(address: string): {
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash" | null;
  exchangeName: string | null;
} {
  const entry = byAddress.get(address);
  if (!entry) return { requiresMemo: false, memoType: null, exchangeName: null };
  return {
    requiresMemo: entry.requiresMemo,
    memoType: entry.requiresMemo ? entry.memoType : null,
    exchangeName: entry.name,
  };
}
