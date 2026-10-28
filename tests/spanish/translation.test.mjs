// Spanish render option: pure logic in tools/translation.mjs, plus the side panel's copy of the
// key/hash helpers (they must agree, or the panel and the bridge disagree about stale lines).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeLanguage, hashText, titleHash, stepKey, sourceHash, translationStatus, translationProblems, buildLocalizedScript,
  localizedName, driveTitleFor, renderModeFor, allowsPylon, translationRequest, buildTranslationPrompt,
  parseTranslationReply, applyTranslation, carryOverTranslations,
} from '../../tools/translation.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function pilot() {
  return {
    name: 'How-to-Find-a-Project-ID', title: 'How to Find a Project ID', module: 'Marketing',
    driveVideoId: 'EN_DRIVE', driveVideoUrl: 'https://drive/en', pylonArticleId: 'P1', pylonArticleUrl: 'https://pylon/1',
    recording: { id: 'rec1' },
    steps: [
      { index: 0, media: { pre: 'step_a.png' }, narration: "Let's start on the Projects list.", caption: "Let's start on the Projects list." },
      { index: 1, media: { pre: 'step_b.png' }, narration: 'Opening this project shows its details.', caption: 'Project details' },
      { index: 2, media: { pre: 'step_c.png' }, narration: '', caption: '' },
      { index: 3, capture: false, narration: 'not in the video' },
    ],
  };
}
function translated() {
  const s = pilot();
  s.translations = { es: {
    title: 'Cómo encontrar el ID de un proyecto', titleSourceHash: titleHash('How to Find a Project ID'),
    steps: {
      'step_a.png': { narration: 'Empecemos en la lista de “Projects”.', sourceHash: sourceHash(s.steps[0]) },
      'step_b.png': { narration: 'Al abrir este proyecto vemos sus detalles.', caption: 'Detalles del proyecto', sourceHash: sourceHash(s.steps[1]) },
    },
    driveVideoId: 'ES_DRIVE',
  } };
  return s;
}

test('language normalisation: only es is a translation, everything else is English', () => {
  assert.equal(normalizeLanguage('ES'), 'es');
  assert.equal(normalizeLanguage(undefined), 'en');
  assert.equal(normalizeLanguage('fr'), 'en');
});

test('step keys are the screenshot name (stable across reorders), panel and saved shapes agree', () => {
  assert.equal(stepKey({ index: 4, media: { pre: 'step_x.png' } }), 'step_x.png');
  assert.equal(stepKey({ index: 4, captureId: 'x' }), 'step_x.png');
  assert.equal(stepKey({ index: 4 }), 'i4');
});

test('status: untranslated, translated, stale after an English edit, empty lines need nothing', () => {
  const none = translationStatus(pilot(), 'es');
  assert.equal(none.ok, false);
  assert.equal(none.title, 'missing');
  assert.deepEqual(none.steps.map((x) => x.status), ['missing', 'missing', 'empty']);
  assert.match(translationProblems(none), /title not translated; steps 1, 2 not translated/);

  const s = translated();
  assert.equal(translationStatus(s, 'es').ok, true);
  s.steps[1].narration = 'Opening the project shows every detail.';
  const st = translationStatus(s, 'es');
  assert.equal(st.ok, false);
  assert.deepEqual(st.stale.map((x) => x.number), [2]);
  assert.match(translationProblems(st), /step 2 changed in English since translation/);
  s.title = 'How to Locate a Project ID';
  assert.equal(translationStatus(s, 'es').title, 'stale');
});

test('title staleness ignores slug vs human formatting, but not wording', () => {
  const s = translated();
  s.title = 'How-to-Find-a-Project-ID';
  assert.equal(translationStatus(s, 'es').title, 'ok');
  s.title = 'how to find a project id';
  assert.equal(translationStatus(s, 'es').title, 'ok');
  s.title = 'How to Find a Project Number';
  assert.equal(translationStatus(s, 'es').title, 'stale');
});

test('a caption-only English edit also makes the Spanish line stale', () => {
  const s = translated();
  s.steps[1].caption = 'Project details page';
  assert.equal(translationStatus(s, 'es').steps[1].status, 'stale');
});

test('localized script: Spanish text, own name, no English publish links; English untouched', () => {
  const s = translated();
  const before = JSON.stringify(s);
  const es = buildLocalizedScript(s, 'es');
  assert.equal(JSON.stringify(s), before, 'English script must not be modified');
  assert.equal(es.name, 'How-to-Find-a-Project-ID__es');
  assert.equal(es.title, 'Cómo encontrar el ID de un proyecto');
  assert.equal(es.language, 'es');
  assert.equal(es.steps[0].narration, 'Empecemos en la lista de “Projects”.');
  assert.equal(es.steps[0].caption, 'Empecemos en la lista de “Projects”.', 'caption falls back to the Spanish narration');
  assert.equal(es.steps[1].caption, 'Detalles del proyecto');
  assert.equal(es.steps[2].narration, '');
  assert.equal(es.steps[3].narration, 'not in the video', 'non-captured steps are left alone');
  for (const f of ['translations', 'driveVideoId', 'driveVideoUrl', 'pylonArticleId', 'pylonArticleUrl']) assert.equal(es[f], undefined, f);
  assert.equal(buildLocalizedScript(s, 'en'), s);
});

test('never renders English silently: missing or stale lines throw', () => {
  assert.throws(() => buildLocalizedScript(pilot(), 'es'), /not translated/);
  const s = translated();
  s.steps[0].narration = 'Changed English line.';
  assert.throws(() => buildLocalizedScript(s, 'es'), /step 1 changed in English/);
});

test('output names never collide with English: out dir and Drive title', () => {
  assert.equal(localizedName('How-to-Find-a-Project-ID', 'es'), 'How-to-Find-a-Project-ID__es');
  assert.equal(localizedName('How-to-Find-a-Project-ID', 'en'), 'How-to-Find-a-Project-ID');
  assert.equal(driveTitleFor('How to Find a Project ID', 'es'), 'How to Find a Project ID (Spanish)');
  assert.equal(driveTitleFor('How to Find a Project ID', 'en'), 'How to Find a Project ID');
});

test('Pylon guard: Spanish renders are video-only whatever mode is asked for', () => {
  for (const m of ['both', 'pylon', 'video']) assert.equal(renderModeFor(m, 'es'), 'video');
  assert.equal(renderModeFor('preview', 'es'), 'preview');
  for (const m of ['both', 'pylon', 'video', 'preview']) assert.equal(renderModeFor(m, 'en'), m);
  assert.equal(allowsPylon('es'), false);
  assert.equal(allowsPylon('en'), true);
  assert.equal(allowsPylon(undefined), true);
});

test('bridge wires the guards in server-side', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'ai-bridge.mjs'), 'utf8');
  const pub = src.slice(src.indexOf('function publishFinishedRender('));
  const guard = pub.indexOf('if (!allowsPylon(language))');
  assert.ok(guard > 0 && guard < pub.indexOf('publishRenderToPylon('), 'Pylon guard must come before any Pylon call');
  const route = src.slice(src.indexOf("req.url === '/render')"));
  assert.ok(route.indexOf('renderModeFor(askedMode, language)') < route.indexOf("mode === 'pylon' && hasValidExistingRender"), 'mode is coerced before the Article fast path');
  assert.match(src, /if \(LIBRARY_SECRET && language === 'en'\)/, 'translated reports stay out of the library');
});

test('translation request/apply: only missing+stale lines; hashes come from the English sent', () => {
  const s = translated();
  s.steps[0].narration = 'Changed English line.';
  const req = translationRequest(s, 'es');
  assert.equal(req.title, false);
  assert.deepEqual(req.items.map((x) => x.key), ['step_a.png']);
  const prompt = buildTranslationPrompt(s, req, 'es');
  assert.match(prompt, /Latin American Spanish/);
  assert.match(prompt, /“Save”/);
  const reply = parseTranslationReply('```json\n{"lines":{"step_a.png":{"narration":"Línea cambiada — en español."}}}\n```');
  const next = applyTranslation(s, 'es', req, reply, 'T');
  assert.equal(next.steps['step_a.png'].narration, 'Línea cambiada, en español.');
  assert.equal(next.steps['step_b.png'].narration, 'Al abrir este proyecto vemos sus detalles.', 'other lines kept');
  assert.equal(next.driveVideoId, 'ES_DRIVE', 'Spanish Drive id kept');
  assert.equal(translationStatus({ ...s, translations: { es: next } }, 'es').ok, true);
  // English edited again while the model was working: still flagged.
  s.steps[0].narration = 'Edited during translation.';
  assert.equal(translationStatus({ ...s, translations: { es: next } }, 'es').steps[0].status, 'stale');
});

test('a reply that skips a line leaves it flagged rather than blank-translated', () => {
  const s = pilot();
  const req = translationRequest(s, 'es');
  assert.equal(req.title, true);
  const next = applyTranslation(s, 'es', req, { title: 'Cómo encontrar el ID de un proyecto', lines: { 'step_a.png': { narration: 'Hola.' } } });
  const st = translationStatus({ ...s, translations: { es: next } }, 'es');
  assert.equal(st.title, 'ok');
  assert.deepEqual(st.missing.map((x) => x.number), [2]);
});

test('saving keeps the stored translation and Spanish Drive link', () => {
  const existing = translated();
  const incoming = pilot();
  carryOverTranslations(incoming, existing);
  assert.equal(incoming.translations.es.driveVideoId, 'ES_DRIVE');
  const incoming2 = { ...pilot(), translations: { es: { title: 'x', steps: {} } } };
  carryOverTranslations(incoming2, existing);
  assert.equal(incoming2.translations.es.driveVideoId, 'ES_DRIVE');
  assert.equal(incoming2.translations.es.title, 'x', 'incoming text wins');
});

test('side panel helpers match tools/translation.mjs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'extension', 'sidepanel.js'), 'utf8');
  const grab = (name) => { const m = src.match(new RegExp(`function ${name}\\([^]*?\\n}\\n`)); assert.ok(m, name); return m[0]; };
  const lib = new Function(`${grab('trHashText')}${grab('trStepKey')}${grab('trStepSource')}${src.match(/function trSourceHash\(step\)[^\n]*\n/)[0]}
    ${src.match(/function trTitleHash\(t\)[^\n]*\n/)[0]}
    return { trHashText, trStepKey, trSourceHash, trTitleHash };`)();
  for (const t of ['How-to-Find-a-Project-ID', 'Cómo   encontrar ¿el ID?']) assert.equal(lib.trTitleHash(t), titleHash(t));
  for (const t of ['', 'abc', 'Haz clic en “Save” ¿listo? ¡sí! ñ á 😀', 'x'.repeat(500)]) assert.equal(lib.trHashText(t), hashText(t));
  for (const st of pilot().steps.concat([{ index: 9, captureId: 'zz', narration: 'a', caption: 'b' }])) {
    assert.equal(lib.trStepKey(st), stepKey(st));
    assert.equal(lib.trSourceHash(st), sourceHash(st));
  }
});
