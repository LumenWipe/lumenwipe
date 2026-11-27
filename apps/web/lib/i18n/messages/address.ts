import type { Locale } from "@/lib/i18n/locale";
import type { AddressProblem } from "@/lib/utils/validation";

const en = {
  problems: {
    "secret-key":
      "That looks like a secret key. Never paste it here. LumenWipe only needs your public address (starts with G).",
    muxed: "This looks like a muxed address. Use the G address plus the memo your exchange shows.",
    contract:
      "This is a contract address (C...). Closing and analysing contract accounts is not supported yet. Use a Stellar account address (G...).",
    "muxed-contract":
      "This is a muxed contract address (W...). Closing and analysing contract accounts is not supported yet. Use a Stellar account address (G...).",
    prefix: "A Stellar account address starts with G.",
    length: "A Stellar account address has 56 characters.",
    checksum:
      "This address has a typo: its checksum does not match. Copy it again from the source.",
  } satisfies Record<AddressProblem, string>,
  valid: "Valid address",
};

export type AddressCopy = typeof en;

const es: AddressCopy = {
  problems: {
    "secret-key":
      "Eso parece una clave secreta. Nunca la pegues aquí. LumenWipe solo necesita tu dirección pública (empieza con G).",
    muxed:
      "Esto parece una dirección muxed. Usa la dirección G junto con el memo que muestra tu exchange.",
    contract:
      "Esta es una dirección de contrato (C...). Cerrar y analizar cuentas de contrato aún no es compatible. Usa una dirección de cuenta de Stellar (G...).",
    "muxed-contract":
      "Esta es una dirección de contrato muxed (W...). Cerrar y analizar cuentas de contrato aún no es compatible. Usa una dirección de cuenta de Stellar (G...).",
    prefix: "Una dirección de cuenta de Stellar empieza con G.",
    length: "Una dirección de cuenta de Stellar tiene 56 caracteres.",
    checksum:
      "Esta dirección tiene un error: su checksum no coincide. Cópiala de nuevo desde donde la obtuviste.",
  },
  valid: "Dirección válida",
};

export const ADDRESS: Record<Locale, AddressCopy> = { en, es };
