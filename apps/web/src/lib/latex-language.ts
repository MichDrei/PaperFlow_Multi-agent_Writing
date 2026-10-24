/**
 * Monaco 自定义：LaTeX / BibTeX 语法高亮 + PaperFlow 深色主题。
 * Monaco 官方不含 LaTeX，需要自己注册 Monarch 词法。
 */

import type * as Monaco from 'monaco-editor';

export const LATEX_KEYWORDS = [
  'documentclass', 'usepackage', 'RequirePackage', 'begin', 'end', 'title', 'author', 'date',
  'maketitle', 'section', 'subsection', 'subsubsection', 'paragraph', 'chapter', 'part',
  'label', 'ref', 'eqref', 'autoref', 'cite', 'citep', 'citet', 'nocite', 'bibliography',
  'bibliographystyle', 'item', 'caption', 'centering', 'includegraphics', 'input', 'include',
  'textbf', 'textit', 'emph', 'texttt', 'textsc', 'mathrm', 'mathbf', 'frac', 'sum', 'int',
  'alpha', 'beta', 'gamma', 'lambda', 'sigma', 'theta', 'mu', 'mathbb', 'mathcal', 'hline',
  'toprule', 'midrule', 'bottomrule', 'newline', 'noindent', 'hfill', 'vspace', 'hspace',
  'footnote', 'thanks', 'and', 'today', 'abstract', 'figure', 'table', 'equation', 'align',
  'itemize', 'enumerate', 'tabular', 'document', 'newcommand', 'renewcommand', 'def',
];

export const latexLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.latex',
  keywords: LATEX_KEYWORDS,
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
  ],
  tokenizer: {
    root: [
      [/%.*$/, 'comment'],
      [/\$\$/, { token: 'string.math', next: '@displayMath' }],
      [/\$/, { token: 'string.math', next: '@inlineMath' }],
      [/\\[a-zA-Z@]+\*?/, { cases: { '@keywords': 'keyword', '@default': 'type' } }],
      [/\\[^a-zA-Z]/, 'type'],
      [/[{}()[\]]/, '@brackets'],
      [/\[[^\]\n]*\]/, 'attribute.value'],
      [/\d+(\.\d+)?(pt|em|ex|cm|mm|in|%|\\?)?/, 'number'],
      [/[&~^_]/, 'operator'],
    ],
    inlineMath: [
      [/[^$\\]+/, 'string.math'],
      [/\\./, 'string.math'],
      [/\$/, { token: 'string.math', next: '@pop' }],
    ],
    displayMath: [
      [/[^$\\]+/, 'string.math'],
      [/\\./, 'string.math'],
      [/\$\$/, { token: 'string.math', next: '@pop' }],
    ],
  },
};

export const bibtexLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.bibtex',
  tokenizer: {
    root: [
      [/%.*$/, 'comment'],
      [/@[a-zA-Z]+/, 'keyword'],
      [/[a-zA-Z]+\s*=/, 'attribute.name'],
      [/\{/, 'delimiter.curly'],
      [/\}/, 'delimiter.curly'],
      [/"[^"]*"/, 'string'],
      [/\d{4}/, 'number'],
      [/[a-zA-Z][\w:-]*/, 'identifier'],
    ],
  },
};

export const PAPERFLOW_THEME = 'paperflow-dark';

export function registerLatexLanguages(monaco: typeof Monaco): void {
  if (!monaco.languages.getLanguages().some((l) => l.id === 'latex')) {
    monaco.languages.register({ id: 'latex', extensions: ['.tex', '.sty', '.cls'], aliases: ['LaTeX', 'latex'] });
    monaco.languages.setMonarchTokensProvider('latex', latexLanguage);
    monaco.languages.setLanguageConfiguration('latex', {
      comments: { lineComment: '%' },
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '$', close: '$' },
      ],
      surroundingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '$', close: '$' },
      ],
    });
  }
  if (!monaco.languages.getLanguages().some((l) => l.id === 'bibtex')) {
    monaco.languages.register({ id: 'bibtex', extensions: ['.bib'], aliases: ['BibTeX', 'bibtex'] });
    monaco.languages.setMonarchTokensProvider('bibtex', bibtexLanguage);
  }

  monaco.editor.defineTheme(PAPERFLOW_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5b6a80', fontStyle: 'italic' },
      { token: 'keyword', foreground: '7cb7ff' },
      { token: 'type', foreground: 'c792ea' },
      { token: 'string.math', foreground: '7fd1ae' },
      { token: 'string', foreground: 'e5c07b' },
      { token: 'number', foreground: 'f0a45d' },
      { token: 'attribute.value', foreground: '9aa7bd' },
      { token: 'attribute.name', foreground: '7cb7ff' },
      { token: 'delimiter.curly', foreground: '8b98ad' },
      { token: 'delimiter.square', foreground: '8b98ad' },
      { token: 'operator', foreground: 'f4636c' },
    ],
    colors: {
      'editor.background': '#0e121a',
      'editor.foreground': '#e8edf5',
      'editorLineNumber.foreground': '#3d4a60',
      'editorLineNumber.activeForeground': '#9aa7bd',
      'editor.lineHighlightBackground': '#151b26',
      'editor.selectionBackground': '#2a4a7f',
      'editor.inactiveSelectionBackground': '#1e2a40',
      'editorCursor.foreground': '#6ea2ff',
      'editorIndentGuide.background1': '#1d2432',
      'editorGutter.background': '#0e121a',
      'editorWidget.background': '#171d29',
      'editorWidget.border': '#2c3648',
      'editorSuggestWidget.background': '#171d29',
      'editorSuggestWidget.selectedBackground': '#232c3c',
      'scrollbarSlider.background': '#2c364880',
      'scrollbarSlider.hoverBackground': '#3d4a60',
      'minimap.background': '#0e121a',
    },
  });
}
