export default {
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/*/src/**/__tests__/**/*.test.ts",
      "apps/web/src/**/__tests__/**/*.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@": new URL("./apps/web/src", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
    },
  },
};
