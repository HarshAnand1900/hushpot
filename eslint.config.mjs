import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "fhevmTemp/**",
      "tmp/**",
      ".coverage_artifacts/**",
      ".coverage_cache/**",
      ".coverage_contracts/**",
      "artifacts/**",
      "build/**",
      "cache/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "types/**",
      // The frontend is a separate TypeScript project with its own Next.js lint setup and
      // its own tsconfig. Linting it from here makes the root parser read every file
      // against a project that does not contain them, which fails on all of them.
      "web/**",
      "*.env",
      "*.log",
      "coverage.json",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreIIFE: true, ignoreVoid: true }],
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "_", varsIgnorePattern: "_" }],
    },
  },
);
