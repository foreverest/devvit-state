import { defineConfig } from "eslint/config";
import globals from "globals";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const layers = [
  {
    name: "server",
    globals: globals.node,
    project: "./tsconfig.server.json",
  },
  {
    name: "client",
    globals: globals.browser,
    project: "./tsconfig.client.json",
  },
  {
    name: "shared",
    globals: globals.browser,
    project: "./tsconfig.shared.json",
  },
];

export default defineConfig([
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  ...layers.map((layer) => ({
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: [`src/${layer.name}/**/*.{ts,tsx}`],
    languageOptions: {
      ecmaVersion: 2023,
      globals: layer.globals,
      parserOptions: {
        project: [layer.project],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": ["off"],
      "no-unused-vars": ["off"],
    },
  })),
]);
