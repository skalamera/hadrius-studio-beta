// Target disambiguation and data-vs-UI evidence for drift checks (pure, import-safe, no I/O).
//
// A recorded click target that matches SEVERAL elements today is not by itself drift: in shared tenants (Sandbox,
// Academy) other people's records add rows ("Restore project" on 2 archived projects), and some pages already had
// the same control twice when they were recorded (header + empty-state "Add template"). Given the recorded target
// rect and, when available, the recorded + today screenshots, pick the candidate that IS the recorded element:
//   1. visual: the recorded row/area around the target (a horizontal band of the main area for record rows, a padded
//      box for other controls) vs the same-size area around each candidate today (small shift search, luma MAD);
//      this follows the RECORD when rows moved;
//   2. bbox: nearest rect (viewport-normalized) with a clear margin, when no images or not a record row.
// A choice needs a clear margin; otherwise the target stays ambiguous (finding, never clicked). Record rows whose
// identity the images can't settle stay ambiguous rather than falling back to position (could be another record).
// For every other candidate it also reports whether it was already on screen when the video was recorded
// (same area, OCR-free pixel comparison): all present = the ambiguity pre-dates the recording (not drift);
// extra matches inside record rows = data drift.
export const DISAMBIG = Object.freeze({
  bboxMaxPx: 24,          // nearest candidate must be within this many px (centre + size) of the recorded rect
  bboxMarginPx: 32,       // ... and the runner-up at least this much further away
  visualMaxMad: 14,       // best visual match must have a mean abs luma diff <= this (0..255)
  visualMarginRatio: 1.6, // runner-up MAD >= best * ratio ...
  visualMarginAbs: 4,     // ... and >= best + abs
  presentMaxMad: 8,       // an alternative is "already in the recording" when its area matches this well
  mainLeft: 240,          // app sidebar width at 1600 px: record-row bands start right of it
  inkLuma: 190, inkDiff: 48, blobMatchMax: 12, rowTolPx: 24, maxBlobs: 4, // record rows: text blobs found in the recording
  rowMatchMin: 0.3, rowMatchOtherMax: 0.1, // chosen row: >= 30% of its text ink found at the recorded row; others <= 10% // 'ink' metric for record rows: dark pixels on either side that differ by > inkDiff
  shiftX: 16, shiftY: 8, step: 2, scale: 2,
});

const clampRect = (r, w, h) => {
  const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
  return { x, y, w: Math.max(0, Math.min(w, Math.round(r.x + r.w)) - x), h: Math.max(0, Math.min(h, Math.round(r.y + r.h)) - y) };
};
/** Scale a rect recorded at viewport `from` to viewport `to` (both {w,h}); identity when either is missing. */
export function normRect(rect, from, to) {
  if (!rect) return null;
  if (!from?.w || !from?.h || !to?.w || !to?.h || (from.w === to.w && from.h === to.h)) return { ...rect };
  const sx = to.w / from.w, sy = to.h / from.h;
  return { x: rect.x * sx, y: rect.y * sy, w: rect.w * sx, h: rect.h * sy };
}
/** Centre distance + half the size difference, in px. */
export function rectDistance(a, b) {
  if (!a || !b) return Infinity;
  const dc = Math.hypot((a.x + a.w / 2) - (b.x + b.w / 2), (a.y + a.h / 2) - (b.y + b.h / 2));
  return dc + 0.5 * (Math.abs(a.w - b.w) + Math.abs(a.h - b.h));
}

/** Downscaled luma plane {w,h,s,data} of a decoded RGBA image {width,height,data}. */
export function lumaPlane(img, s = DISAMBIG.scale) {
  const w = Math.floor(img.width / s), h = Math.floor(img.height / s), data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let t = 0;
    for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) { const o = ((y * s + yy) * img.width + (x * s + xx)) * 4; t += 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]; }
    data[y * w + x] = t / (s * s);
  }
  return { w, h, s, data, width: img.width, height: img.height };
}
/**
 * Min mean-abs luma difference between plane A's region `ra` and plane B's same-size region at `rb` shifted by up to
 * (shiftX, shiftY) px (full-resolution px). Regions are full-resolution rects. Infinity when nothing overlaps.
 */
export function regionMad(A, ra, B, rb, { shiftX = DISAMBIG.shiftX, shiftY = DISAMBIG.shiftY, step = DISAMBIG.step, ys = null, metric = 'mad', inkLuma = DISAMBIG.inkLuma, inkDiff = DISAMBIG.inkDiff } = {}) {
  const s = A.s, w = Math.floor(ra.w / s), h = Math.floor(ra.h / s);
  const ax = Math.floor(ra.x / s), ay = Math.floor(ra.y / s);
  if (w < 2 || h < 2 || ax < 0 || ay < 0 || ax + w > A.w || ay + h > A.h) return Infinity;
  let best = Infinity;
  const dys = ys ?? (() => { const o = []; for (let d = -shiftY; d <= shiftY; d += step) o.push(Math.round(rb.y) + d); return o; })();
  for (const yFull of dys) for (let dx = -shiftX; dx <= shiftX; dx += step) {
    const bx = Math.floor((rb.x + dx) / s), by = Math.floor(yFull / s);
    if (bx < 0 || by < 0 || bx + w > B.w || by + h > B.h) continue;
    let m;
    if (metric === 'ink') {
      // Fraction (x100) of "ink" pixels (dark on either side: text, icons) that differ: background-insensitive, so a
      // different record's row text scores high even though most of the row is white.
      let ink = 0, bad = 0;
      for (let y = 0; y < h; y++) { const ia = (ay + y) * A.w + ax, ib = (by + y) * B.w + bx; for (let x = 0; x < w; x++) { const a = A.data[ia + x], b = B.data[ib + x]; if (a < inkLuma || b < inkLuma) { ink++; if (Math.abs(a - b) > inkDiff) bad++; } } }
      m = ink < 20 ? Infinity : (100 * bad) / ink;
    } else {
      let t = 0;
      for (let y = 0; y < h; y++) { const ia = (ay + y) * A.w + ax, ib = (by + y) * B.w + bx; for (let x = 0; x < w; x++) t += Math.abs(A.data[ia + x] - B.data[ib + x]); if (t / (w * h) >= best) break; }
      m = t / (w * h);
    }
    if (m < best) best = m;
  }
  return best;
}


/** Text-like ink blobs (column runs separated by >= gapPx of background) in a full-res rect of a luma plane. */
export function inkBlobs(P, rect, { inkLuma = DISAMBIG.inkLuma, gapPx = 12, minW = 24, minInk = 30 } = {}) {
  const s = P.s, x0 = Math.max(0, Math.floor(rect.x / s)), y0 = Math.max(0, Math.floor(rect.y / s)), x1 = Math.min(P.w, Math.floor((rect.x + rect.w) / s)), y1 = Math.min(P.h, Math.floor((rect.y + rect.h) / s));
  const col = []; for (let x = x0; x < x1; x++) { let n = 0; for (let y = y0; y < y1; y++) if (P.data[y * P.w + x] < inkLuma) n++; col.push(n); }
  const out = []; let start = -1, last = -1, ink = 0; const gap = Math.ceil(gapPx / s);
  const flush = () => { if (start >= 0) { let top = y1, bot = y0; for (let x = start; x <= last; x++) for (let y = y0; y < y1; y++) if (P.data[y * P.w + x0 + x] < inkLuma) { if (y < top) top = y; if (y > bot) bot = y; }
    const b = { x: (x0 + start) * s, y: top * s, w: (last - start + 1) * s, h: (bot - top + 1) * s, ink }; if (b.w >= minW && ink >= minInk && b.h >= 4) out.push(b); } start = -1; ink = 0; };
  for (let i = 0; i < col.length; i++) { if (col[i] > 0) { if (start < 0) start = i; else if (i - last > gap) { flush(); start = i; } last = i; ink += col[i]; } }
  if (start >= 0) flush();
  return out;
}
/** Best 'ink' score (0 = identical ink, 100 = all different) of template rect `t` (in plane A) anywhere inside
 *  `area` of plane B; {score, x, y} at full resolution. */
export function findTemplate(A, t, B, area, { inkLuma = DISAMBIG.inkLuma, inkDiff = DISAMBIG.inkDiff, stride = 1 } = {}) {
  // Symmetric: mismatching pixels where EITHER side has ink, over the template's ink count (so extra text in B
  // counts against the match as much as missing text).
  const s = A.s, tx = Math.floor(t.x / s), ty = Math.floor(t.y / s), tw = Math.max(1, Math.floor(t.w / s)), th = Math.max(1, Math.floor(t.h / s));
  const ax0 = Math.max(0, Math.floor(area.x / s)), ay0 = Math.max(0, Math.floor(area.y / s)), ax1 = Math.min(B.w - tw, Math.floor((area.x + area.w) / s) - tw), ay1 = Math.min(B.h - th, Math.floor((area.y + area.h) / s) - th);
  const tpl = new Float32Array(tw * th); let nInk = 0;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const v = A.data[(ty + y) * A.w + tx + x]; tpl[y * tw + x] = v; if (v < inkLuma) nInk++; }
  if (nInk < 10) return { score: Infinity, x: null, y: null };
  let best = Infinity, bx = null, by = null;
  for (let y = ay0; y <= ay1; y += stride) for (let x = ax0; x <= ax1; x += stride) {
    let bad = 0; const cap = Number.isFinite(best) ? (best * nInk) / 100 : Infinity;
    for (let yy = 0; yy < th && bad < cap; yy++) { const rb = (y + yy) * B.w + x, rt = yy * tw;
      for (let xx = 0; xx < tw; xx++) { const a = tpl[rt + xx], b = B.data[rb + xx]; if ((a < inkLuma || b < inkLuma) && Math.abs(a - b) > inkDiff) bad++; } }
    const sc = (100 * bad) / nInk; if (sc < best) { best = sc; bx = x * s; by = y * s; }
  }
  return { score: best, x: bx, y: by };
}

const isRecord = (m) => !!(m?.recordHint && (m.recordHint.id || m.recordHint.label));
/** The comparison area around a target: a main-area row band for record rows, else a padded box. */
export function areaAround(rect, { record, width, height, mainLeft = DISAMBIG.mainLeft, refH = null }) {
  const h = refH ?? rect.h;
  if (record) { const x0 = rect.x >= mainLeft ? mainLeft : 0; return clampRect({ x: x0, y: rect.y - 6, w: width - x0, h: h + 12 }, width, height); }
  return clampRect({ x: rect.x - 40, y: rect.y - 8, w: rect.w + 80, h: h + 16 }, width, height);
}

/**
 * matches: today's name matches [{bbox, recordHint, name, ...}] (capture.mjs candidates).
 * recordedRect/recordedViewport: the script target's bbox + viewport; todayViewport defaults to 1600x900.
 * recorded/today: lumaPlane()s or null.
 * -> null (fewer than 2 matches) | {status:'resolved'|'ambiguous', chosen (index into matches) | null, method, reason,
 *    candidates:[{index, bbox, distancePx, visualMad, record, recordLabel, presentInRecording}], margin, preexisting,
 *    extraAlternatives, extraAreData}
 */
export function disambiguateTarget({ matches, recordedRect, recordedViewport = null, todayViewport = { w: 1600, h: 900 }, recorded = null, today = null, T = DISAMBIG }) {
  if (!Array.isArray(matches) || matches.length < 2) return null;
  const rr = normRect(recordedRect, recordedViewport, todayViewport);
  const images = !!(recorded && today && recorded.width === today.width && recorded.height === today.height);
  const anyRecord = matches.some(isRecord);
  const cands = matches.map((m, index) => ({ index, bbox: m.bbox ?? null, distancePx: rr && m.bbox ? Math.round(rectDistance(rr, m.bbox) * 10) / 10 : null, visualMad: null, record: isRecord(m), recordLabel: m.recordHint?.label ?? null, presentInRecording: null }));
  if (images && rr && anyRecord) {
    // Record rows: identify the RECORD, not the position. The text blobs of each candidate's row (record name, id,
    // owner, date; sidebar and the target control itself excluded) are searched in the recorded frame: near the
    // recorded target's row (identity) and anywhere (was this record on screen at all when recorded).
    const near = { x: 0, y: rr.y - T.rowTolPx, w: recorded.width, h: rr.h + 2 * T.rowTolPx };
    for (const c of cands.slice(0, 30)) if (c.bbox) {
      const band = { x: T.mainLeft, y: c.bbox.y - 6, w: today.width - T.mainLeft, h: c.bbox.h + 12 };
      const blobs = inkBlobs(today, band).filter((b) => b.x >= T.mainLeft && !(b.x < c.bbox.x + c.bbox.w && b.x + b.w > c.bbox.x)).sort((a, b) => b.ink - a.ink).slice(0, T.maxBlobs);
      const total = blobs.reduce((a, b) => a + b.ink, 0);
      let rowInk = 0, anyInk = 0;
      for (const b of blobs) {
        const n = findTemplate(today, b, recorded, near); if (n.score <= T.blobMatchMax) { rowInk += b.ink; anyInk += b.ink; continue; }
        const a = findTemplate(today, b, recorded, { x: 0, y: 0, w: recorded.width, h: recorded.height }); if (a.score <= T.blobMatchMax) anyInk += b.ink;
      }
      c.blobs = blobs.length;
      c.rowMatch = total ? Math.round((rowInk / total) * 1000) / 1000 : null;
      c.recordInRecording = total ? Math.round((anyInk / total) * 1000) / 1000 : null;
      c.visualMad = c.rowMatch == null ? null : Math.round((1 - c.rowMatch) * 10000) / 100; // 0 = row text found at the recorded row
    }
  } else if (images && rr) {
    const recArea = areaAround(rr, { record: false, width: recorded.width, height: recorded.height, mainLeft: T.mainLeft });
    for (const c of cands) if (c.bbox) {
      const area = areaAround({ ...c.bbox, h: rr.h }, { record: false, width: today.width, height: today.height, mainLeft: T.mainLeft });
      const mad = regionMad(recorded, recArea, today, area, T);
      c.visualMad = Number.isFinite(mad) ? Math.round(mad * 100) / 100 : null;
    }
  }
  const byD = cands.filter((c) => c.distancePx != null).sort((a, b) => a.distancePx - b.distancePx);
  const byV = cands.filter((c) => c.visualMad != null).sort((a, b) => a.visualMad - b.visualMad);
  const bboxOk = byD.length >= 2 && byD[0].distancePx <= T.bboxMaxPx && byD[1].distancePx - byD[0].distancePx >= T.bboxMarginPx;
  const visOk = byV.length >= 2 && (anyRecord
    ? byV[0].visualMad <= 100 * (1 - T.rowMatchMin) && byV[1].visualMad >= 100 * (1 - T.rowMatchOtherMax)
    : byV[0].visualMad <= T.visualMaxMad && byV[1].visualMad >= Math.max(byV[0].visualMad * T.visualMarginRatio, byV[0].visualMad + T.visualMarginAbs));
  const margin = { bboxPx: byD.length >= 2 ? Math.round((byD[1].distancePx - byD[0].distancePx) * 10) / 10 : null, visualMad: byV.length >= 2 ? Math.round((byV[1].visualMad - byV[0].visualMad) * 100) / 100 : null };
  let chosen = null, method = null, reason;
  if (visOk) { chosen = byV[0].index; method = bboxOk && byD[0].index === chosen ? 'visual+bbox' : 'visual'; reason = method === 'visual' && byD[0]?.index !== chosen ? 'recorded_area_found_elsewhere' : 'recorded_area_matches'; }
  else if (images && anyRecord) reason = 'record_identity_unclear';
  else if (anyRecord) reason = 'record_identity_unverifiable'; // no recorded frame: never pick a record row by position
  else if (bboxOk) { chosen = byD[0].index; method = 'bbox'; reason = 'nearest_to_recorded_rect'; }
  else reason = byD.length < 2 ? 'no_recorded_rect' : 'no_clear_margin';
  // Was each other candidate already on screen in the recording? Record rows: their band anywhere in the recorded
  // main area (rows move when others are added); other controls: the same spot (layout).
  if (images) for (const c of cands) {
    if (c.index === chosen || !c.bbox) continue;
    if (c.record) { c.presentInRecording = c.recordInRecording != null ? c.recordInRecording >= T.rowMatchMin : null; continue; }
    const area = areaAround(c.bbox, { record: false, width: today.width, height: today.height });
    const mad = regionMad(today, area, recorded, area, T);
    c.presentMad = Number.isFinite(mad) ? Math.round(mad * 100) / 100 : null;
    c.presentInRecording = c.presentMad != null && c.presentMad <= T.presentMaxMad;
  }
  const alts = cands.filter((c) => c.index !== chosen);
  const extra = images ? alts.filter((c) => c.presentInRecording === false) : [];
  return {
    status: chosen == null ? 'ambiguous' : 'resolved', chosen, method, reason, candidates: cands, margin, imagesUsed: images,
    preexisting: images && chosen != null ? alts.every((c) => c.presentInRecording === true) : null,
    extraAlternatives: images ? extra.length : null,
    extraAreData: images && extra.length ? extra.every((c) => c.record) : null,
  };
}
