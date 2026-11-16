import { Operation, type xdr } from "@stellar/stellar-sdk";

type Decoded = ReturnType<typeof Operation.fromXDRObject>;
type DecodedOf<T extends Decoded["type"]> = Extract<Decoded, { type: T }>;

function isOfType<T extends Decoded["type"]>(op: Decoded, type: T): op is DecodedOf<T> {
  return op.type === type;
}

/** Decodes an operation and narrows it to `type`, throwing when it is any other operation. */
export function decodeOperation<T extends Decoded["type"]>(
  op: xdr.Operation,
  type: T
): DecodedOf<T> {
  const decoded = Operation.fromXDRObject(op);
  if (!isOfType(decoded, type)) throw new Error(`expected ${type}, got ${decoded.type}`);
  return decoded;
}
