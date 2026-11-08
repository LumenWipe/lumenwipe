import { waitFor } from "@testing-library/react";

const IMPLICIT_ROLES: Record<string, string> = {
  BUTTON: "button",
  DIALOG: "dialog",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
  INPUT: "textbox",
  SELECT: "combobox",
  TEXTAREA: "textbox",
};

function trimmed(text: string | null | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}…` : flat;
}

function accessibleName(element: Element): string {
  const label = element.getAttribute("aria-label");
  if (label) return label;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
  }
  if (element.id) {
    const forLabel = element.ownerDocument.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    if (forLabel) return forLabel.textContent ?? "";
  }
  return element.textContent ?? "";
}

/** A one-line description of an element, so a failed assertion never prints the node itself. */
export function describeElement(element: Element | null | undefined): string {
  if (!element) return String(element);
  if (element === element.ownerDocument.body) return "<body>";
  const role =
    element.getAttribute("role") ??
    (element.tagName === "A" && element.hasAttribute("href")
      ? "link"
      : IMPLICIT_ROLES[element.tagName]);
  const parts = [`<${element.tagName.toLowerCase()}>`];
  if (role) parts.push(`role=${role}`);
  const name = trimmed(accessibleName(element));
  if (name) parts.push(`"${name}"`);
  const testId = element.getAttribute("data-testid");
  if (testId) parts.push(`data-testid=${testId}`);
  if (element.id) parts.push(`id=${element.id}`);
  return parts.join(" ");
}

function focusMismatch(expected: Element, label: string | undefined): Error {
  const what = label ? `${label}: ` : "";
  return new Error(
    `${what}expected focus on ${describeElement(expected)}, but it is on ${describeElement(document.activeElement)}`
  );
}

/** Waits, bounded, until `element` holds focus. Use when focus moves in an effect or a timer. */
export async function expectFocused(
  element: Element,
  label?: string,
  timeout = 500
): Promise<void> {
  await waitFor(
    () => {
      if (document.activeElement !== element) throw focusMismatch(element, label);
    },
    { timeout, interval: 10, onTimeout: (error) => error }
  );
}

/** Checks focus is on `element` right now, for asserting focus stayed where it was. */
export function expectFocusedNow(element: Element, label?: string): void {
  if (document.activeElement !== element) throw focusMismatch(element, label);
}

/** Checks focus is not on `element` right now. */
export function expectNotFocused(element: Element, label?: string): void {
  if (document.activeElement === element) {
    const what = label ? `${label}: ` : "";
    throw new Error(
      `${what}expected focus to leave ${describeElement(element)}, but it is still there`
    );
  }
}

/** Identity check between two elements that reports both briefly instead of dumping them. */
export function expectSameElement(
  actual: Element | null | undefined,
  expected: Element | null | undefined,
  label?: string
): void {
  if (actual !== expected) {
    const what = label ? `${label}: ` : "";
    throw new Error(`${what}expected ${describeElement(expected)}, got ${describeElement(actual)}`);
  }
}
