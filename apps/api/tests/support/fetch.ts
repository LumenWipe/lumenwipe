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

/** A fresh copy of `response`, so a scripted answer can be served more than once. */
export async function replay(response: Response): Promise<Response> {
  const body = response.body === null ? null : await response.clone().arrayBuffer();
  const { status, statusText, headers } = response;
  return new Response(body, { status, statusText, headers });
}
