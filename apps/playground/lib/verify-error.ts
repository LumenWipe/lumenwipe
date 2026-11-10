import "server-only";

/** A transaction the playground refuses to sign or send: `message` is a fixed code, never data
 *  from the transaction or the API. */
export class PlaygroundVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaygroundVerificationError";
  }
}
