import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

GlobalRegistrator.register();

// The real module only throws on import, so a route handler could not load in a test. Set here
// for the whole run, so no test depends on file order.
await Bun.plugin({
  name: "server-only",
  setup(build) {
    build.module("server-only", () => ({ exports: {}, loader: "object" }));
  },
});

// @testing-library/react computes `screen` at module-load time against
// `document` (see @testing-library/dom's screen.js) - it must not be
// imported until happy-dom's GlobalRegistrator.register() above has run,
// or it throws "a global document has to be available". A dynamic import
// defers evaluation until after that call, unlike a static import (which
// would execute in file order regardless of hoisting).
const { cleanup } = await import("@testing-library/react");

afterEach(cleanup);
