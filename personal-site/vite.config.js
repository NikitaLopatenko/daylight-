import { defineConfig } from "vite";

// GitHub project Pages URL: https://nikitalopatenko.github.io/daylight-/
// When you later move to nikitalopatenko.github.io or a custom domain, set base to "/".
const base = process.env.VITE_BASE || "/daylight-/";

export default defineConfig({
  base,
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
