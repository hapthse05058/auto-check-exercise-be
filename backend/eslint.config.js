const js = require("@eslint/js");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      ".gitnexus/**",
      ".codegraph/**",
    ],
  },

  js.configs.recommended,

  // Backend source (CommonJS, Node).
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Keep Prettier last so it disables all stylistic rules it owns.
  prettier,
];
