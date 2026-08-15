const { GlobalRegistrator } = require("@happy-dom/global-registrator");
const { afterEach } = require("bun:test");

GlobalRegistrator.register();

const { cleanup } = require("@testing-library/react");
afterEach(cleanup);
