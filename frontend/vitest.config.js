import { defineConfig } from "vitest/config";

// `node` rather than jsdom: api.js talks to the network and to localStorage,
// both of which the tests stub. Pulling in a DOM would be weight for nothing.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.js"] },
});
