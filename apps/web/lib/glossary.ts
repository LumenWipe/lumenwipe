export interface GlossaryTerm {
  concept: string;
  preferred: string;
  banned: readonly string[];
}

export const GLOSSARY: readonly GlossaryTerm[] = [
  {
    concept: "the act of ending an account",
    preferred: "close",
    banned: ["wind-down", "demolish"],
  },
  { concept: "the tool that closes accounts", preferred: "closer", banned: ["demolisher"] },
  { concept: "clearing key material from memory", preferred: "clear", banned: ["wipe"] },
  {
    concept: "the shared account an exchange close passes through",
    preferred: "relay account",
    banned: ["mediator", "intermediary"],
  },
  { concept: "what the wallet asks the user to approve", preferred: "transaction", banned: [] },
];

const FORMS: Record<string, string> = {
  "wind-down": "wind[-\\s]?downs?",
  demolish: "demolish(?:es|ed|ing|ers?)?|demolition",
  demolisher: "demolishers?",
  wipe: "wip(?:e|es|ed|ing)",
  mediator: "mediators?|mediated|mediating",
  intermediary: "intermediar(?:y|ies)",
};

const BRAND = /lumenwipe/gi;

export const BANNED_WORDS: readonly string[] = GLOSSARY.flatMap((t) => t.banned);

const BANNED_PATTERN = new RegExp(
  `(?<![\\w-])(?:${BANNED_WORDS.map((w) => FORMS[w] ?? w).join("|")})(?![\\w-])`,
  "gi"
);

export function findBannedWords(text: string): string[] {
  return (text.replace(BRAND, " ").match(BANNED_PATTERN) ?? []).map((m) => m.toLowerCase());
}
