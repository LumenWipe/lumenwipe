import { describe, expect, test } from "bun:test";
import type { Metadata } from "next";
import AnalyzeLayout, { metadata as analyze } from "@/app/[network]/analyze/layout";
import CompleteLayout, { metadata as complete } from "@/app/[network]/complete/layout";
import ExecuteLayout, { metadata as execute } from "@/app/[network]/execute/layout";
import ReviewLayout, { metadata as review } from "@/app/[network]/review/layout";

type StepLayout = (props: { children: React.ReactNode }) => React.ReactNode;

// The root layout's template turns each title into "<title> | LumenWipe". "Close result" stays
// neutral because the server cannot know the outcome; the complete page sets the closed or
// incomplete title at runtime.
const STEPS: [step: string, layout: StepLayout, metadata: Metadata, title: string][] = [
  ["analyze", AnalyzeLayout, analyze, "Plan the close"],
  ["review", ReviewLayout, review, "Review the plan"],
  ["execute", ExecuteLayout, execute, "Sign the close"],
  ["complete", CompleteLayout, complete, "Close result"],
];

describe("close step titles", () => {
  test.each(STEPS)("%s sets its own title", (_step, _layout, metadata, title) => {
    expect(metadata.title).toBe(title);
  });

  test.each(STEPS)("%s renders its page unchanged", (_step, layout) => {
    const page = { page: true } as unknown as React.ReactNode;
    expect(layout({ children: page })).toBe(page);
  });

  test("every step has a different title", () => {
    expect(new Set(STEPS.map(([, , metadata]) => metadata.title)).size).toBe(STEPS.length);
  });
});
