/**
 * One unambiguous JSON text for a value, so a signature over it means the same thing in every
 * implementation. It is RFC 8785 (JCS) restricted to what a registry holds: objects (keys in
 * UTF-16 code unit order), arrays (order kept), strings, booleans and safe integers, with no
 * whitespace. Anything else (null, undefined, a float, -0, a non-plain object, a sparse array)
 * throws, so a payload that cannot be written one way is never signed or verified.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error("A canonical payload holds only safe integers.");
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("A canonical payload holds only plain objects.");
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new Error(
    "A canonical payload holds only objects, arrays, strings, booleans and integers."
  );
}
