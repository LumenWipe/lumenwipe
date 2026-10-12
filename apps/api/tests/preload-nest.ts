// @nestjs/core 12 is ESM; @nestjs/throttler 6 still require()s it, which Bun rejects if the first load is that require() racing the async ESM graph.
await import("@nestjs/core");
export {};
