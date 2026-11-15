import { Fragment, isValidElement, type ReactNode } from "react";

/** The text a reader sees in a tree of host elements, whitespace collapsed and screen-reader-only
 *  text left out. Throws on a component element, whose output it cannot see, so content that
 *  stops being plain markup fails loudly instead of being dropped. */
export function nodeText(node: ReactNode): string {
  return collect(node).replace(/\s+/g, " ").trim();
}

function collect(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collect).join("");
  if (isValidElement<{ children?: ReactNode; className?: string }>(node)) {
    if (typeof node.type !== "string" && node.type !== Fragment) {
      throw new Error("nodeText reads host elements only, not a component");
    }
    if (node.props.className?.split(/\s+/).includes("sr-only")) return "";
    return collect(node.props.children);
  }
  throw new Error(`nodeText cannot read ${typeof node}`);
}
