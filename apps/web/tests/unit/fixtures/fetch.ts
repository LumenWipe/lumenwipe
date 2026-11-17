type FetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;

const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input.toString();

/** A `fetch` that answers every request with `handler`, never touching the network. */
export function fakeFetch(handler: FetchHandler): typeof fetch {
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => handler(urlOf(input), init),
    { preconnect: () => {} }
  );
}
