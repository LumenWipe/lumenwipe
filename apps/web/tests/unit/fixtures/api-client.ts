import { LumenWipeClient } from "@lumenwipe/sdk";
import { fakeFetch } from "./fetch";

/** A real API client answering only with `methods`; any other call is refused without I/O. */
export function apiClient(methods: Partial<LumenWipeClient> = {}): LumenWipeClient {
  const refuse = fakeFetch((url) => Promise.reject(new Error(`${url} is not stubbed`)));
  return Object.assign(
    new LumenWipeClient({ baseUrl: "https://api.invalid", apiKey: "test", fetch: refuse }),
    methods
  );
}
