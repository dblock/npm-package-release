import js from "@eslint/js";
import markdown from "@eslint/markdown";
import preferences from "eslint-plugin-markdown-preferences";
import paragraph from "eslint-plugin-markdown-preferences-paragraph";
import proseSpellcheck from "eslint-plugin-prose-spellcheck";
import yml from "eslint-plugin-yml";

export default [
  { ignores: ["coverage/**", ".release/**"] },
  { ...js.configs.recommended, files: ["**/*.js"] },
  ...yml.configs["flat/recommended"],
  {
    files: ["**/*.md"],
    plugins: {
      markdown,
      "markdown-preferences": preferences,
      paragraph,
      "prose-spellcheck": proseSpellcheck,
    },
    language: "markdown/gfm",
    rules: {
      ...markdown.configs.recommended[0].rules,
      "markdown/no-duplicate-headings": "error",
      "markdown/no-bare-urls": "error",
      "markdown-preferences/heading-casing": ["error", {
        style: "Title Case",
        preserveWords: [
          ...preferences.resources.defaultPreserveWords,
          "npm",
          "npm-package-release",
          "Non-Goals",
          "0.x",
          "1.x",
        ],
      }],
      "markdown-preferences/no-heading-trailing-punctuation": "error",
      "paragraph/wrap": ["error", { width: "nowrap" }],
      "prose-spellcheck/spellcheck": ["error", {
        dictionaries: [
          "@cspell/dict-en_us",
          "@cspell/dict-software-terms",
          "./.spellcheck.txt",
        ],
        baseDir: import.meta.dirname,
      }],
    },
  },
];
