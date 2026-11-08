const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const href = input instanceof Request ? input.url : String(input);
    const url = URL.canParse(href) ? new URL(href) : null;
    if (url && !LOOPBACK.test(url.hostname)) {
      return Promise.reject(
        new Error(`real network request blocked in the lab tests: ${url.href}`)
      );
    }
    return realFetch(input, init);
  },
  realFetch
);
