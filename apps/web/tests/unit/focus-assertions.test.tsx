import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import {
  describeElement,
  expectFocused,
  expectFocusedNow,
  expectNotFocused,
  expectSameElement,
} from "./fixtures/focus";

function Page() {
  return (
    <main>
      <h1 tabIndex={-1}>{"A heading that runs on well past the sixty character limit set"}</h1>
      <label htmlFor="memo">Memo</label>
      <input id="memo" data-testid="memo-field" />
      <button aria-labelledby="go-label">x</button>
      <span id="go-label">Go now</span>
      <a href="https://example.com" aria-label="Elsewhere">
        link
      </a>
      <div role="status">Saved</div>
    </main>
  );
}

async function failure(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the assertion to fail");
}

test("an element is described in one short line", () => {
  render(<Page />);
  expect(describeElement(screen.getByRole("heading"))).toBe(
    '<h1> role=heading "A heading that runs on well past the sixty character limit…"'
  );
  expect(describeElement(screen.getByRole("textbox"))).toBe(
    '<input> role=textbox "Memo" data-testid=memo-field id=memo'
  );
  expect(describeElement(screen.getByRole("button"))).toBe('<button> role=button "Go now"');
  expect(describeElement(screen.getByRole("link"))).toBe('<a> role=link "Elsewhere"');
  expect(describeElement(screen.getByRole("status"))).toBe('<div> role=status "Saved"');
  expect(describeElement(document.body)).toBe("<body>");
  expect(describeElement(null)).toBe("null");
});

test("a focus wait resolves once focus lands and fails with both elements named", async () => {
  render(<Page />);
  const heading = screen.getByRole("heading");
  setTimeout(() => heading.focus(), 20);
  await expectFocused(heading);

  const started = performance.now();
  const message = await failure(() => expectFocused(screen.getByRole("button"), "after save", 50));
  expect(performance.now() - started).toBeLessThan(1000);
  expect(message).toBe(
    'after save: expected focus on <button> role=button "Go now", but it is on <h1> role=heading "A heading that runs on well past the sixty character limit…"'
  );
  expect(message).not.toContain("\n");
});

test("the synchronous checks report short messages", async () => {
  render(<Page />);
  const input = screen.getByRole("textbox");
  input.focus();
  expectFocusedNow(input);
  expectNotFocused(screen.getByRole("button"));
  expectSameElement(screen.getByLabelText("Memo"), input);

  expect(await failure(() => expectFocusedNow(document.body))).toBe(
    'expected focus on <body>, but it is on <input> role=textbox "Memo" data-testid=memo-field id=memo'
  );
  expect(await failure(() => expectNotFocused(input, "typing"))).toBe(
    'typing: expected focus to leave <input> role=textbox "Memo" data-testid=memo-field id=memo, but it is still there'
  );
  expect(await failure(() => expectSameElement(screen.getByRole("link"), input))).toBe(
    'expected <input> role=textbox "Memo" data-testid=memo-field id=memo, got <a> role=link "Elsewhere"'
  );
});
