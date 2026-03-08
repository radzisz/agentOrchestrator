export default {
  test: {
    globals: true,
    environment: "node",
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
    },
  },
};
