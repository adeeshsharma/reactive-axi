import { readFileSync } from "node:fs";

// Leaf module - node builtins only, no sibling imports. This is what makes the AXI
// --version fast path (see bin/reactive-axi.js) able to answer before the heavy command
// graph (cli.js -> server.js -> express/proxy/dev-server-manager) ever loads. If VERSION
// moves into cli.js, importing it re-pulls the whole graph and the fast path buys nothing.
export const VERSION =
  process.env.REACTIVE_AXI_BUILD_VERSION ||
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
