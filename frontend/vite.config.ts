import { defineConfig } from "vite";

export default defineConfig({
  base: "/cash-trail/",
  server: {
    proxy: {
      "/cash-trail/api": {
        target: "http://localhost:8000",
        rewrite: (path) => path.replace(/^\/cash-trail/, ""),
      },
    },
  },
});
