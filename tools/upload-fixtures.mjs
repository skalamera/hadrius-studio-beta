// Hadrius Studio — file-upload support for the AI recorder and the replayer.
//
// The agent's action set was click/type/press/wait, which made every upload workflow unreachable:
// seven workflows in tools/coverage-taxonomy.json are tagged `file` precisely because a file picker
// is an OS dialog, not a DOM element. Worse, a page's real <input type="file"> is almost always
// visually hidden behind a styled dropzone, so it never even appears in the snapshot the model sees.
//
// So the agent never targets the input directly. It targets the VISIBLE control a human would click
// ("Choose document", a dropzone), and attachFile() works out how to get bytes into the page:
//   1. the target already IS a file input          -> setInputFiles on it
//   2. clicking it opens an OS file chooser        -> intercept the filechooser event and set files
//   3. neither                                     -> find the hidden input nearest the target
//
// Both tools/ai-record.mjs (recording) and renderer/replay.mjs (re-rendering) call this, so a step
// recorded with an upload replays through exactly the same path it was recorded through.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'ai-fixtures');

/** Placeholder documents, deliberately obviously fake — they get uploaded into a real tenant. */
export const FIXTURES = {
  pdf: 'sample-document.pdf',
  docx: 'sample-document.docx',
  csv: 'sample-upload.csv',
};

/**
 * Loose hint -> fixture path. The model may say "pdf", "a csv", or the filename itself; anything
 * unrecognised falls back to the PDF, which is what most document-upload flows expect.
 */
export function resolveFixture(hint) {
  const h = String(hint || '').toLowerCase();
  const key = /csv/.test(h) ? 'csv' : /docx?|word/.test(h) ? 'docx' : 'pdf';
  const file = path.join(FIXTURE_DIR, FIXTURES[key]);
  if (!fs.existsSync(file)) throw new Error(`upload fixture missing: ${file}`);
  return file;
}

/**
 * Tag the nearest <input type="file"> to `locator` so it can be addressed by a stable selector.
 * A real function, not a string: locator.evaluate() treats a string as an expression, so a
 * stringified arrow evaluates to a function object it then can't serialize — silently returning
 * nothing rather than running.
 */
const tagNearestFileInput = (el) => {
  const mark = (i) => { if (!i) return false; i.setAttribute('data-kbs-file-input', '1'); return true; };
  for (let n = el; n; n = n.parentElement) {          // nearest input inside an ancestor of the target
    const found = n.querySelector && n.querySelector('input[type="file"]');
    if (found) return mark(found);
    if (n.tagName === 'BODY') break;
  }
  return mark(document.querySelector('input[type="file"]')); // last resort: the only one on the page
};

/**
 * Put a fixture file into the page through `locator` (the visible control, not the hidden input).
 * Returns { how, file } describing which of the three routes worked — worth logging, since which
 * one fires is the clearest signal of how the page implements its uploader.
 */
export async function attachFile(page, locator, hint) {
  const file = resolveFixture(hint);

  const isFileInput = await locator
    .evaluate((el) => el.tagName === 'INPUT' && el.getAttribute('type') === 'file')
    .catch(() => false);
  if (isFileInput) {
    await locator.setInputFiles(file);
    return { how: 'direct', file };
  }

  // A real click is what opens the chooser, so this has to race the click rather than follow it.
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 4000 }),
      locator.click({ timeout: 6000 }),
    ]);
    await chooser.setFiles(file);
    return { how: 'filechooser', file };
  } catch {
    // Not a chooser-opening control (or the click was swallowed) — fall through.
  }

  const tagged = await locator.evaluate(tagNearestFileInput).catch(() => false);
  if (!tagged) throw new Error('no <input type="file"> found on or near that control');
  const input = page.locator('[data-kbs-file-input="1"]').first();
  try {
    await input.setInputFiles(file);
    return { how: 'hidden-input', file };
  } finally {
    await page.evaluate(() => document.querySelectorAll('[data-kbs-file-input]')
      .forEach((el) => el.removeAttribute('data-kbs-file-input'))).catch(() => {});
  }
}
