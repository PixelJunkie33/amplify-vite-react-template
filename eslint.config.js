import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Rules shared by both halves of the project. They have to live inside a
 * config block that also pulls in the TypeScript plugin — a flat config will
 * not resolve a plugin's rule from a block that does not register it.
 */
const shared = {
  // An empty catch is how this codebase says "this failure is fine, and the
  // comment above says why" — around localStorage, for instance.
  "no-empty": ["error", { allowEmptyCatch: true }],
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
};

export default tseslint.config(
  // The Amplify backend is AWS-generated and deploys through `ampx`, not
  // through anything here. It is left entirely alone, including by the linter.
  { ignores: ["dist/**", "data/**", "node_modules/**", "amplify/**", ".amplify/**"] },

  // The server, the bots and the tests run in Node.
  {
    files: ["server/**/*.ts", "bots/**/*.ts", "vite.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: shared,
  },

  // Tests poke at parsed JSON whose shape is exactly what they are asserting
  // about. Casting through `any` there is the point, not an oversight.
  {
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },

  // The spectator view runs in a browser.
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules, ...shared },
  },
);
