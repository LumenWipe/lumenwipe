import { describe, expect, test } from "bun:test";
import { BANNED_WORDS, GLOSSARY, findBannedWords } from "@/lib/glossary";

describe("findBannedWords", () => {
  test("finds each banned term and its inflections", () => {
    expect(findBannedWords("The wind-down is done")).toEqual(["wind-down"]);
    expect(findBannedWords("wind down")).toEqual(["wind down"]);
    expect(findBannedWords("We demolished it, demolishing too")).toEqual([
      "demolished",
      "demolishing",
    ]);
    expect(findBannedWords("keys are Wiped")).toEqual(["wiped"]);
    expect(findBannedWords("a shared mediator")).toEqual(["mediator"]);
    expect(findBannedWords("an intermediary account")).toEqual(["intermediary"]);
  });

  test("does not flag the brand name", () => {
    expect(findBannedWords("LumenWipe closes accounts")).toEqual([]);
    expect(findBannedWords("https://docs.lumenwipe.com")).toEqual([]);
  });

  test("does not flag identifiers or longer words", () => {
    expect(findBannedWords("mediatorRequired")).toEqual([]);
    expect(findBannedWords("useDemolishStore")).toEqual([]);
    expect(findBannedWords("swiped")).toEqual([]);
  });

  test("preferred words are clean", () => {
    for (const t of GLOSSARY) expect(findBannedWords(t.preferred)).toEqual([]);
    expect(BANNED_WORDS.length).toBeGreaterThan(0);
  });
});
