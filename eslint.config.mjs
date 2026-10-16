import globals from 'globals';

// Scope/import mistakes break lazily opened screens despite valid JS syntax.
export default [{
  files: ['static/app.js', 'static/js/**/*.js'],
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    globals: {
      ...globals.browser,
      // These globals are supplied by the bundled browser libraries.
      marked: 'readonly', DOMPurify: 'readonly', mermaid: 'readonly',
      hljs: 'readonly', JSZip: 'readonly', QRCode: 'readonly', L: 'readonly',
      MathJax: 'readonly', mammoth: 'readonly', docx: 'readonly',
      pdfjsLib: 'readonly', Sortable: 'readonly', katex: 'readonly',
    },
  },
  rules: { 'no-undef': 'error' },
}];
