// Read by next.config.mjs, so plain JavaScript: the config is loaded before anything is compiled.

export const DOCS_URL = "https://docs.lumenwipe.com";

export const API_CATALOG_URL = "https://api.lumenwipe.com/.well-known/api-catalog";

/** The homepage's Link header: where a machine client finds the API, the docs and llms.txt. */
export const HOMEPAGE_LINK = [
  `<${API_CATALOG_URL}>; rel="api-catalog"`,
  `<${DOCS_URL}>; rel="service-doc"`,
  `</llms.txt>; rel="describedby"; type="text/plain"`,
].join(", ");
