import type { Locale } from "@/lib/i18n/locale";
import type { AddressProblem } from "@/lib/utils/validation";

const en = {
  problems: {
    "secret-key":
      "That looks like a secret key. Never paste it here. LumenWipe only needs your public address (starts with G).",
    muxed: "This looks like a muxed address. Use the G address plus the memo your exchange shows.",
    prefix: "A Stellar account address starts with G.",
    length: "A Stellar account address has 56 characters.",
    checksum:
      "This address has a typo: its checksum does not match. Copy it again from the source.",
  } satisfies Record<AddressProblem, string>,
  valid: "Valid address",
};

export type AddressCopy = typeof en;

export const ADDRESS: Record<Locale, AddressCopy> = { en, es: en };
