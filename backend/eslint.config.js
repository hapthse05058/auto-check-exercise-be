const js = require("@eslint/js");
const prettier = require("eslint-config-prettier");
const importPlugin = require("eslint-plugin-import");
const globals = require("globals");

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
    plugins: { import: importPlugin },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "import/order": [
        "warn",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            ["parent", "sibling"],
            "index",
          ],
          "newlines-between": "always",
        },
      ],
      "import/no-duplicates": "error",

      // JS General
      eqeqeq: ["error", "always"],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "error",
    },
  },

  // Keep Prettier last so it disables all stylistic rules it owns.
  prettier,
];
