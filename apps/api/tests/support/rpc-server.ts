import { rpc } from "@stellar/stellar-sdk";

class FakeRpcServer extends rpc.Server {
  constructor(methods: Partial<rpc.Server>) {
    super("https://rpc.invalid");
    for (const name of Object.getOwnPropertyNames(rpc.Server.prototype)) {
      if (name === "constructor") continue;
      Reflect.set(this, name, () => Promise.reject(new Error(`rpc.Server.${name} is not stubbed`)));
    }
    // Healthy with no ledger fields, as some providers answer: a ledger read then goes to the
    // stubbed `getLatestLedger`.
    Reflect.set(this, "getHealth", () => Promise.resolve({ status: "healthy" }));
    Object.assign(this, methods);
  }
}

/** A real `rpc.Server` answering only with `methods`; any other method rejects without I/O. */
export function fakeRpcServer(methods: Partial<rpc.Server> = {}): rpc.Server {
  return new FakeRpcServer(methods);
}
