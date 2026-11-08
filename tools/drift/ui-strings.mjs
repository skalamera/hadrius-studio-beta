// Human-visible UI text in frontend source (JSX text and string literals that read like labels), normalised the same
// way as on-screen text so the two can be compared. Pure; parses with the TypeScript compiler API (no type checking).
import ts from 'typescript';

const NON_TEXT_ATTRS = new Set(['className', 'class', 'style', 'id', 'key', 'href', 'src', 'variant', 'size', 'color', 'as', 'type', 'name', 'role',
  'data-testid', 'testId', 'intent', 'tone', 'align', 'side', 'icon', 'width', 'height', 'form', 'method', 'target', 'rel', 'autoComplete', 'inputMode', 'htmlFor']);
const CLASS_CALLS = /^(cn|clsx|cva|twMerge|classNames|cx|tv)$/;
const LOG_CALLS = /^(console\.\w+|logger\.\w+|Sentry\.\w+|captureException|track\w*)$/;
const IDENTIFIER = /^[a-z0-9_\-:\/.\[\]#@=%!]+$/;
const CLASS_TOKEN = /^[a-z0-9\-:\[\]\/.!%#]+$/;

/** Lowercase, straight quotes, no ellipsis or trailing colon/asterisk, single spaces. */
export function normalizeText(s) {
  return String(s ?? '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u2026|\.{3}/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[\s:*]+$/, '').trim();
}

/** Text that reads like a label, normalised; null for class lists, identifiers, paths, very short or long strings. */
export function labelText(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < 4 || s.length > 80 || !/[A-Za-z]{3}/.test(s)) return null;
  if (/^(https?:|\/|\.\/|@|#)/.test(s) || IDENTIFIER.test(s)) return null;
  const toks = s.split(' ');
  if (toks.length > 1 && toks.every((t) => CLASS_TOKEN.test(t))) return null;
  if (toks.length === 1 && !/^[A-Z]/.test(s)) return null;
  return normalizeText(s) || null;
}

/** Set of normalised label strings in one source file. */
export function uiStrings(source, fileName) {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const out = new Set();
  const add = (t) => { const v = labelText(t); if (v) out.add(v); };
  const visit = (n, skip) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    let sk = skip;
    if (ts.isJsxAttribute(n) && NON_TEXT_ATTRS.has(n.name.getText(sf))) sk = true;
    if (ts.isCallExpression(n)) { const callee = n.expression.getText(sf); if (CLASS_CALLS.test(callee) || LOG_CALLS.test(callee)) sk = true; }
    if (!sk) {
      if (ts.isJsxText(n)) add(n.text);
      else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) add(n.text);
    }
    ts.forEachChild(n, (c) => visit(c, sk));
  };
  visit(sf, false);
  return out;
}

/** Normalised non-empty on-screen labels (DOM innerText lines/table cells), plus each without a trailing count. */
export function visibleLines(text) {
  const out = new Set();
  // Browsers separate cells in an HTML table row with tabs, not newlines. Treat a cell as its own label
  // without splitting ordinary words ("Permissions & groups" is still not a label named "Groups").
  for (const line of String(text ?? '').split(/[\n\t]/)) {
    const n = normalizeText(line);
    if (!n) continue;
    out.add(n);
    const noCount = n.replace(/\s*\(?\d+\)?$/, '').trim();
    if (noCount && noCount !== n) out.add(noCount);
  }
  return out;
}

/** Whole-phrase containment after normalising both sides. */
export function containsPhrase(haystack, phrase) {
  const p = normalizeText(phrase);
  if (!p) return false;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(normalizeText(haystack));
}

const LITERAL_IN_LINE = /"([^"\n]{4,80})"|'([^'\n]{4,80})'|>([^<>{}\n]{4,80})</g;
const BARE_TEXT = /^[A-Za-z][A-Za-z0-9 ,.'’&?!:/-]{3,79}$/;
const JS_WORD = /^(export|import|return|const|let|var|function|if|else|case|default|type|interface|from|async|await|throw|new|class|extends|switch|break|continue|while|for|do|try|catch|finally|yield|typeof|declare|enum|namespace|module|public|private|protected|static|readonly)\b/;

/** Label texts on one +/- diff line: quoted literals, inline JSX text, or a line that is only JSX text. Never code. */
export function labelsInDiffLine(line) {
  const body = String(line ?? '').replace(/^[+-]/, '');
  const out = [];
  for (const m of body.matchAll(LITERAL_IN_LINE)) { const t = labelText(m[1] ?? m[2] ?? m[3]); if (t) out.push(t); }
  const bare = body.trim();
  if (!out.length && BARE_TEXT.test(bare) && !JS_WORD.test(bare)) { const t = labelText(bare); if (t) out.push(t); }
  return out;
}
