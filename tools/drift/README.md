# Local visual candidate foundation

This directory does **not** start the bridge, read `.env`, call providers, browse Academy, render, save shared scripts, or publish. Imports have no side effects.

```sh
node tools/drift/candidate.mjs --base /absolute/base.script.json \
  --recordings-root /absolute/original/_recordings \
  --manifest /absolute/replacements.json --output /absolute/NEW-candidate-directory
```

The output directory must not already exist. Its parent must exist. The explicit recording root contains `<base.recording.id>/<media filename>`. Output contains `candidate.script.json`, exact `base.script.json` bytes, `identified-base.script.json`, `manifest.json`, content-addressed `artifacts/`, and `_recordings/<new recording ID>/`. This mirrors the existing single-root layout but is NOT automatically registered with the renderer: its hardcoded repository recording root is intentionally unchanged. No render-readiness claim is made.

Manifest:

```json
{
  "baseHash": "canonical SHA-256 of the input JSON",
  "structuralChanges": [],
  "changes": [{
    "stepId": "exact-existing-stable-step-id",
    "beforeHash": "canonical SHA-256 of the complete original step",
    "imagePath": "replacement.png",
    "sha256": "SHA-256 of complete replacement PNG bytes"
  }]
}
```

CLI image paths resolve relative to the manifest; API image paths are caller supplied. Optional `target` and `dpr` fields may change geometry only, not target semantics. All other changes, including narration and captions, are rejected. Intentional empty strings remain empty. `captureId` is regenerated from the new PNG hash and agrees with `media.pre`, avoiding stale extension screenshot resolution. Original captures, including superseded ones, are copied without hard links; originals are not modified.

`identify()` returns an independent identity-enriched snapshot (UUID defaults), preserves existing IDs, and rejects invalid/duplicate IDs. For legacy scripts, first prepare and retain an identified **local copy**, then build the manifest against that copy; generated IDs must be reused, not regenerated for each attempt. This is not an editor round-trip fix or shared migration.

Limits: PNG screenshots only, supported non-interlaced 8-bit grayscale/RGB/grayscale-alpha/RGBA. All referenced media must resolve to regular files within the original recording directory, have safe flat filenames, and pass PNG structure/CRC/inflate/raster checks. Unsupported images, clips and other non-string media structures block, never silently disappear. This is a bounded format validator, not a full browser PNG decoder. Source files are rechecked before completion; this is a local snapshot check, not a cross-process/server CAS or permanent filesystem lock. Immutable here means exclusive/content-addressed writes plus read-only file modes, not protection from an owner deliberately chmod/unlinking files. Failed owned output is removed; preexisting output is never overwritten. No crash-recovery or remote archive durability is provided yet.

Candidate readiness proves local source-byte/JSON preservation only. It does not prove preserved TTS takes, encoded segments, audio, MP4 timing, captions as rendered, or decoded output equality. Existing renderer caption fallback and extension metadata-loss paths remain untouched and must be fixed/tested before using this for production.

Tests (Node built-ins, synthetic PNGs/JSON only):

```sh
TMPDIR=/Users/stephenskalamera/.hermes/cache/scratch node --test tests/drift/*.test.mjs
```

## Read-only baseline inventory of existing walkthroughs

```sh
TMPDIR=/Users/stephenskalamera/.hermes/cache/scratch .venv/bin/python -m renderer.baseline_inventory \
  --repo /Users/stephenskalamera/Documents/hadrius-studio \
  --output /Users/stephenskalamera/.hermes/cache/scratch/NEW-baseline-inventory [--only <script-name>] [--probe-media]
```

Stdlib only; imports have no side effects and it never imports `tts.py`/`assemble.py` (which prune/utime caches).
It reads `scripts/*.script.json` (excluding `_studio*` internal records), `out/_recordings/<recording.id>/`,
`out/<name>/{report,assembly,render-key}.json`, the final `out/<name>/<name>.mp4` and the narration files
`assembly.json` references. `--probe-media` adds read-only, 30 s-bounded `ffprobe` (duration/fps/frames/audio).
Symlinks/`..` escaping the repo/out/recording roots are refused (`path_escape`); audio rendered from another
checkout is reported (`narration_audio_outside_repo`) and not read. The output directory must be new and outside
the repo. It writes `inventory.json` (per item), `summary.json` (tier/blocker counts, declared vs enumerated),
`pilot_candidates.json` (top 10) and `source_check.json` (sha256+mtime of every JSON read, size+mtime of media read,
before vs after; non-zero exit if anything changed).

Tiers (each with explicit reasons; `blockers` lists every reason by name):

- `candidate_ready` — every capture step has a safe flat `media.pre` that exists and passes PNG signature/IHDR
  CRC/IEND checks; no `captureId`/`media.pre` mismatch or shared captures across steps.
- `visual_render_evidence` — candidate_ready plus final MP4, an `assembly.json` whose slides map 1:1 (step index +
  `src`) to the script's captures with current narration/captions, and `start`/`sdur`/`content_offset` timing
  (with `--probe-media`: probe ok, audio stream, duration within 1 s of assembly). Pre-`src` assemblies are
  `assembly_legacy_no_src`, not guessed.
- `audio_takes_recoverable` — every narrated assembly slide's audio file is still on disk inside `out/`.
- `strict_exact_preservation_ready` is always `false` for legacy videos: the final MP4 is not segmented into
  independently decodable cells, so a targeted update needs an approved one-time rebaseline.

Pilot ranking: all three tiers + `driveVideoId` + `pylonArticleId`, then no-FX first, fewest steps, name. IDs only
are emitted; Drive/Pylon URLs are never copied. No step has a stable `id` yet (warning on every item).

## Separate local synthetic media proof

The hard-cut demo below remains separate from candidate creation. The additional
`renderer.transitions` fixture exercises the local candidate CLI explicitly; neither
harness is connected to the bridge or existing production renderer.
With FFmpeg/ffprobe on PATH and Pillow installed in `.venv`:

```sh
TMPDIR=/Users/stephenskalamera/.hermes/cache/scratch .venv/bin/python -m unittest discover -s tests/renderer -p 'test_*.py' -v
TMPDIR=/Users/stephenskalamera/.hermes/cache/scratch .venv/bin/python -m renderer.incremental --output "$TMPDIR/NEW-UNUSED-demo-directory"
```

Supply a **new** directory under TMPDIR with an existing parent. Outputs include
`baseline.mp4`, `repair/candidate.mp4`, independently encoded cells, a hashed
`baseline-manifest.json`, `local-approval.json` and `verification.json`.
The proof uses three 320×180, 12 fps, one-second H.264 hard-cut holds and a
three-second 48 kHz mono AAC tone. Only the middle hold changes; other encoded
cell bytes are copied, then video and the complete original audio are stream-copy
muxed. Verification compares decoded protected frames, native frame timestamps,
complete audio packet payload hashes/timestamps/skip-discard data and decoded
float PCM. A no-op returns the baseline artifact itself, without remuxing.

Approval is trusted local test input, **not** authenticated approval. Allowed
frames derive from stable step IDs plus the exact approved manifest hash; an
arbitrary renderer dirty-range field is rejected. Toolchain versions are pinned.
This bounded harness buffers decoded evidence in memory and has 60-second
subprocess limits. Unsupported timelines/profiles fail closed. Failed owned
outputs may remain for diagnosis; only a verification report denotes success.
It does not support existing-video migration, renderer FX/crossfades, changed
narration, production integration, automatic drift detection or publishing.

## Explicit synthetic dissolve + local candidate integration

```sh
TMPDIR=/Users/stephenskalamera/.hermes/cache/scratch .venv/bin/python -m renderer.transitions --output /Users/stephenskalamera/.hermes/cache/scratch/NEW-UNUSED-transition-demo
```

This executed fixture uses seven gap-free one-second cells at 320×180/12 fps:
intro `[0,12)`, first hold `[12,24)`, dissolve `[24,36)`, middle hold
`[36,48)`, dissolve `[48,60)`, last hold `[60,72)`, outro `[72,84)`.
Ranges are half-open frame indices. Ordered dissolve dependencies contain both
adjacent stable slide IDs. Bookends depend on their edge slide. The pinned
manifest and exact synthetic profile/topology derive scope; caller dirty ranges,
missing cells, wrong dependency ordering and changed profile/timing are rejected.
The middle update rebuilds exactly the two dissolves and middle hold; the four
outer hold/bookend files are copied byte-identically. Protected ranges are
`[0,24)` and `[60,84)` (48 frames); dirty closure is `[24,60)` (36 frames).

The demo generates a stable-ID `base.script.json`, synthetic PNGs, then invokes
`tools/drift/candidate.mjs` with a single PNG replacement. Only that isolated
candidate's PNG paths feed the synthetic cell donor. Original narration **text**
and captions (including intentional empty caption) are checked unchanged. Audio
is a seven-second 48 kHz mono AAC fixture tone, not real narration and not TTS.
Complete audio payload/timing/priming and decoded PCM equality, protected decoded
frames and all native video timestamps are verified by the existing verifier.
A no-op returns the original file/hash. `verification.json` records the result;
`baseline.mp4`, `repair/candidate.mp4`, baseline manifest, local approval,
`local-candidate/` and replacement cells remain in the new scratch directory.

This is **not** production candidate-render enrollment, real Academy transitions,
legacy migration, arbitrary FX/crossfades, caption rendering, audio editing,
provider synthesis or publication. Dissolves are explicit Pillow RGB blends
`(frame+1)/13`, independently encoded as closed GOPs with the same pinned profile.
Only RGB 320×180 PNG donors are accepted. Existing candidate `renderReady:false`
remains correct for production; no bridge/extension/package behavior is changed.

## FX dependency closure + local one-time rebaseline of a real walkthrough

`renderer/fx_scope.py` (import-safe, stdlib; never imports `assemble.py`) turns a baseline Extra FX
`assembly.json` plus a change set `{slide -> {screenshot_changed, target_changed}}` into integer, gap-free
cells of the FINAL video and the exact dirty/protected frame ranges. Constants are checked against
`assemble.py` source in the tests (FPS 30, slide dissolve 0.8 s, card crossfades 0.65 s, outro 0.8 s).
Content frame 0 is `ceil(content_offset*30)`; slide i starts at `ceil(round(start,3)*30)` (fx_plan's
rule); every transition window is widened by 1 guard frame. Screenshot-only = the slide's dissolve-in,
hold and dissolve-out (persisted `_fx`/`_cam` frozen). A target-geometry change expands to the whole FX
screen (+ boundary dissolves, + slides sharing a caption-position run) and sets
`scope_expansion_required`. Non-FX assemblies, unknown slides, inconsistent `start`/`sdur`/`_fx`, overlapping
dissolves and duration mismatches are rejected.

```sh
TMPDIR=$HOME/.hermes/cache/scratch .venv/bin/python -m renderer.rebaseline \
  --repo /Users/stephenskalamera/Documents/hadrius-studio --name How-to-Find-a-Project-ID \
  --output $HOME/.hermes/cache/scratch/NEW-pilot-rebaseline
```

Reads `out/<name>/{assembly.json,<name>.mp4}` read-only (sha256/size/mtime before == after), re-encodes the
ORIGINAL decoded frames per cell (libx264 crf 18 medium, `-g 300 -bf 0`, closed GOP, 1/15360 timescale like
the original), concatenates by stream copy and stream-copies the ORIGINAL audio. Writes
`baseline-rebuilt.mp4`, `cell-*.mp4`, `baseline-manifest.json` (profile
`legacy-fx-rebaseline-h264-1080p30-v1`, accepted by `preservation.load_scope`, bound to a hashed copy of the
assembly), `verification.json` and `contact-sheet.jpg`. Pilot result: 810/810 frames, identical pts, audio
packets/priming/PCM identical, PSNR min 46.9 dB / mean 56.3, SSIM min 0.9975; a recolored slide-02 donor
passes with 662 protected frames equal; an out-of-scope cell is rejected. The video is a disclosed lossy
re-encode: a LOCAL review artifact, never uploaded. Donor rendering of genuinely new slide content through
assemble's FX path is not implemented. The real-pilot unittest is opt-in:
`HADRIUS_REAL_PILOT_REBASELINE=1` (about 2.5 minutes).

## Single-slide Extra FX donor render (genuinely new screenshot) + end-to-end splice

```sh
TMPDIR=$HOME/.hermes/cache/scratch .venv/bin/python -m renderer.drift_render \
  --rebaseline-dir $HOME/.hermes/cache/scratch/<rebaseline> --candidate-dir $HOME/.hermes/cache/scratch/<candidate.mjs output> \
  --slide-step-id <stable step id> --output $HOME/.hermes/cache/scratch/NEW-drift-render [--golden-build-dir out/<name>/_build]
```

`renderer/fx_draw.py` keeps `assemble.py` the single source of truth WITHOUT importing or executing it: it `ast`-parses
the file, compiles only `caption_png, highlight_png, fx_big, cam_clamp, fx_spotlight_png, fx_ripple, fx_view_at,
cam_view_at, render_camera_segment, fit_slide_to_frame` into a fresh namespace with literal constants
(`ast.literal_eval`: W/H/FPS/XF/FONT/CAM_*/FX_*/CAP_CLEAR/SEG_ENCODE/INTERMEDIATE_ENCODE), frozen `FX=CAMERA=True`,
explicit `NEEDS_DRAWN_HIGHLIGHT` and scratch `out`/`tmp`. Fails closed on a missing/duplicate function or constant,
a non-literal constant, a changed `font`/`FX`/`CAMERA`/`NEEDS_DRAWN_HIGHLIGHT` statement, or any extracted function
reading an unprovided global (symtable). Per-function source sha256s and a drawer fingerprint go into `donor.json`.

**Caption font layout is pinned (`--font-layout basic`).** `ImageFont.truetype(FONT, 40)` silently uses RAQM when
Pillow can dlopen Homebrew's libfribidi, else BASIC. The pilot (rendered Oct 20) used BASIC; fribidi was installed
Oct 27, so the SAME assemble.py now draws different caption glyphs (every cap PNG and every segment differed until
pinned). With BASIC, the pilot's seg01/02/03 re-render BIT-identical (bitstream sha256 equal), cap/hl/hls/spot PNGs
and annotated/slide_02.png byte-equal, and assemble's xfade stitch reproduces `_build/video.mp4` frame-identical
(447/447). The final MP4's [313,461) window (content [150,298)) vs that reproduction: PSNR min 48.0 / SSIM min
0.9978 (3 later crossfade encodes). `tests/renderer/test_fx_draw.py` runs this read-only golden check when the
pilot's `_build` exists.

`renderer/drift_render.py`: candidate (`identified-base` vs `candidate` script; only media/captureId/target/dpr of the
approved step may differ) -> `plan_donor` checks BEFORE rendering: interior slide only, assembly<->script mapping by
step index + `src`, the from-recording.mjs slide port (`fx_draw.from_recording_slide`, JS Math.round) + extracted
`fit_slide_to_frame` on the new PNG's own size must reproduce the frozen `target`/`viewport`, same PNG size, fx_plan's
screen rule (route/viewport/160x90 MAD vs `FX_SCREEN_MAD`) must reproduce the frozen `_fx.first`, and `fx_scope`
must not expand. Rejections: `scope_expansion_required:{screenshot_size_changed,viewport_changed,
target_geometry_changed,screen_grouping_changed,fx_scope}`, `unsupported_edge_slide`, `unsupported_step_change`,
`unrelated_step_changed`, `unsupported_narration_or_caption_change`. Then the changed slide AND its unchanged
neighbours are rendered through the frozen persisted plan (`_cam/_fx/_cap_*`, `sdur`, captions re-drawn from the
same text); with `--golden-build-dir` neighbours must decode-equal the real `_build/segNN.mp4`. assemble's xfade
filter graph stitches the 3-slide sub-chain (transition frames asserted) to lossless FFV1, the fx_scope dirty
cells are cut and encoded in the rebaseline profile (+`setsar=1`, metadata only: x264 writes SAR into the SPS),
spliced by `rebaseline.assemble_candidate`, and verified by `preservation.verify_visual_update`.

Real pilot (`drift_render.real_pilot_end_to_end`; opt-in test `HADRIUS_REAL_PILOT_DRIFT_RENDER=1`, optionally
`HADRIUS_PILOT_REBASELINE_DIR=<existing rebaseline>`, about 4 min): stable-ID local script copy (uuid5) + scratch
captures, slide 2 with a red "NEW: Export project IDs" banner away from the target, `candidate.mjs`, donor, splice:
662 protected frames equal, audio packets/priming/PCM equal, the 6 untouched cells byte-identical, 148 changed
frames exactly [313,461), banner diff ~78-96 grey levels inside its camera-projected box vs ~0.4-0.6 outside;
a control donor with the ORIGINAL screenshot scores PSNR min 45.2 dB vs the rebaseline in the dirty cells; moved
highlight / 1440x900 / inverted (regrouped screen) screenshots are rejected before any MP4 is written.

Limits: local review artifact only (rebaseline is lossy; donor cells are one fresh generation next to protected
frames that went through the original 5-encode chain, so a faint quality step at the cell boundary is possible).
First/last slides (card crossfades), clip slides, narration/caption/timing/target changes, multi-slide changes and
`caption_pos` reports are not supported. NEEDS_DRAWN_HIGHLIGHT is assumed True (candidate scripts come from
recordings). The font layout must be known for the baseline (no automatic detection). Not wired into the bridge,
extension, publisher or `render.sh`; `assemble.py` is unchanged.

## Read-only recapture + drift compare (`capture.mjs`, `compare.mjs`)

```sh
node tools/drift/capture.mjs --script scripts/<name>.script.json --out $TMPDIR/NEW-run \
  [--profile /Users/stephenskalamera/Documents/hadrius-studio/.browser-profile-ai-<slot>]   # default: .browser-profile-drift
node tools/drift/compare.mjs --run $TMPDIR/NEW-run --recordings out/_recordings/<recording.id>
```

Both modules are import-safe (Playwright is imported lazily). `capture.mjs` refuses to start unless the profile is an
AI-slot profile (`.browser-profile-ai-N`) with no `SingletonLock`, no Chromium running with `--user-data-dir=<profile>`,
and `GET 127.0.0.1:8787/render/status` reports `running:false`. It probes sign-in headlessly with ai-record's
`isSignedIn` logic; if signed out it reopens the SAME profile visibly, prints
`WAITING FOR MANUAL HADRIUS SIGN-IN in the visible Chromium window` and polls up to 10 min (4 consecutive signed-in
checks). It never types, fills or reads credentials; on timeout it exits `login_required`. Recapture is headless,
1600x900, service workers blocked, per-step 60 s / overall 5 min, browser closed in `finally`.

Actions: only the script's own `navigate` URLs and the ONE recorded click per `click` step, resolved by exact
role+name, then role+name with dates/times normalised (reported as `name_changed`), then a unique CSS match with the
same role/tag. Missing, ambiguous (>1) or non-project-detail-link targets are NOT clicked (finding recorded; the next
navigate step continues). Step screenshots are taken pre-action, like the recorder's `media.pre`.

Request guard (`classifyRequest`): GET/HEAD/OPTIONS pass. App hosts are `*.hadrius.com` AND `hadriusapi.com` (the live
backend). Non-GET to app hosts whose path names
create/update/delete/archive/mutation/remove/destroy/upsert, or GraphQL mutations, are blocked AND abort the run.
Cognito refresh (`GetTokensFromRefreshToken` — the live app uses this rotation API; blocking it bounces the app to
`/auth/sign-in` — or `InitiateAuth` with `REFRESH_TOKEN(_AUTH)`, `GetUser`/`GetId`/`GetCredentialsForIdentity`),
`/oauth2/token` refresh, GraphQL queries and read-named POSTs (search/list/query/filter/count/lookup/get) pass but are
PostHog `/flags` feature-flag reads pass (logged; blocking them could change UI); every other non-GET (Sentry,
`hadriusapi.com/.../track-event/`) is blocked and logged. During the visible manual sign-in only (`mode:'manual_login'`)
Cognito sign-in calls and third-party identity/analytics POSTs pass (logged); app-host writes stay blocked.

`compare.mjs` (pure Node PNG decode/encode): per step `diffFraction` (per-channel max diff > 24), SSIM (8x8 luma
windows, stride 4), changed-region boxes (16 px cells, 8-connected), target rect delta. Dynamic regions are text
nodes in TODAY's DOM matching date/time/relative-time patterns; changes inside them are reported
(`dynamicChangedPixels`, yellow in the diff) but excluded from `diffFractionNonDynamic`/`ssimMasked`.
Classification precedence: `target_missing` (missing/ambiguous/not_navigation) > `target_geometry_changed`
(any edge > 4 px) > `screenshot_changed` (non-dynamic fraction > 0.002 or masked SSIM < 0.98) > `unchanged`.
Outputs `compare.json`, `diff-NN.png` and `contact-sheet.png` (recorded | today | diff; bar colour = class).
Limits: dynamic detection uses today's DOM only (recorded-frame text positions are unknown); loading/skeleton
states, hover and scroll position differences count as screenshot changes — inspect the sheet before concluding drift.

Tests: `TMPDIR=... node --test tests/drift/*.test.mjs` (`capture.test.mjs`: guard, sign-in probe, preflight, target
resolution on synthetic descriptors, compare thresholds on synthetic PNGs).


## Changed narration + timing shift (one interior slide), real pilot verified

```sh
TMPDIR=$HOME/.hermes/cache/scratch .venv/bin/python -m renderer.narration_update \
  --rebaseline-dir $TMPDIR/<rebaseline> --script <stable-ID script copy> --recordings-dir <media.pre captures dir> \
  --narration-manifest <approved change JSON> --build-dir out/<name>/_build [--golden-build-dir out/<name>/_build] \
  --output $TMPDIR/NEW-narration-update
```

`candidate.mjs` still rejects narration edits; the change travels as a separate, trusted LOCAL manifest
`{baselineManifestHash, changes:[{stepId, oldText, newText, newTakePath, newTakeSha256, [newCaption], [takeSource]}]}`.
`oldText` must equal the script AND the assembly narration; the manifest is bound to the baseline manifest hash; one
interior slide only. A caption that mirrored the narration follows it; an independent caption is kept. Everything is
rejected (`old_text_mismatch`, `unknown_step`, `no_narration_change`, `take_hash_mismatch`,
`baseline_manifest_conflict`, `unsupported_edge_slide`, `scope_expansion_required:*`) before any output exists.

- `renderer/audio_rebuild.py` restates assemble's audio graph and PINS every fragment against `assemble.py`'s source
  (fail closed): per-take loudnorm (single pass) + adelay, music bed (static `assets/music_upbeat.wav`, nothing random
  at render time) ducked by sidechaincompress, alimiter, AAC 192k, then the three card `acrossfade`s (0.65/0.65/0.8).
  **Golden (real pilot, unchanged takes):** content/body/support intermediates and the final audio are packet- and
  PCM-identical to the real files (1211 packets, 1238880 samples/ch, max abs diff 0). Every take is located by
  normalized cross-correlation at `content_origin + delay_ms*48` with one constant decode lag (-785 samples) for all.
- `renderer/retime.py`: assemble's sdur rule rounded UP to whole frames (<= 1/30 s extra pause) so every downstream
  boundary shifts by exactly `shift_frames`; fx_plan's move timing re-derived (golden: reproduces every persisted
  `_fx`); the changed screen keeps its persisted drift `span` (a full re-plan would move slide 1 by up to ~8.6 px and
  touch the card crossfade; reported as `replan_drift_deviation_px`); caption position re-decided by assemble's own
  `cam_caption_top` (AST-extracted; golden recomputes every baseline `_cap_top`); camera views of every reused frame
  asserted unchanged.
- `renderer/narration_update.py`: audio golden gate -> render only dissolve-in/hold/dissolve-out of the changed slide
  via `fx_draw` (neighbours with unchanged plans decode-equal `_build/segNN.mp4`) -> copy the other cells byte-for-byte
  at shifted positions -> re-mix the soundtrack once (unchanged take files fed byte-for-byte from copies) -> mux.

Real pilot (How-to-Find-a-Project-ID, slide 2; NEW take is a macOS `say` STAND-IN, never the provider voice):
longer line (9.29 s take) +190 frames (810 -> 1000); shorter line "Open the project." (1.26 s) -51 frames (-> 759, push-in
re-timed 1.5 -> 1.2688 s). Both: 6 reused cells byte-identical and decoded-frame-equal at shifted indices, 3 rendered
cells, pts contiguous, IDR at every cell start, slide-1/3 takes and the new take at their expected offsets (lag -785
samples, peak >= 0.96), A/V offset of unchanged takes within 0.334 ms of the baseline, 522 leading audio packets
(11.1 s) identical to the baseline, caption band of slide 2 changed only. Opt-in test: `HADRIUS_REAL_PILOT_NARRATION=1`
(`test_audio_rebuild`, `test_narration_update`; ~3 min per case).

Limits: first/last slide (card crossfades), silent/removed narration, more than one change, same-screen followers of
the changed slide, `caption_pos`/`no_captions` reports and combined visual+narration changes are rejected. Takes are
assumed to be what assemble mixed (proven only by the golden gate). Rendered cells are one fresh generation beside the
lossy rebaseline; the whole soundtrack is re-encoded (4 AAC generations, as assemble does). Reused dissolves between
two downstream slides keep the baseline's sub-ms blend phase (assemble would differ by <= 0.5 ms of offset rounding).
LOCAL review artifact only: not wired into the bridge, extension, publisher or `render.sh`; `assemble.py` unchanged.

## Unattended Academy sign-in (`academy-login.mjs`)

```sh
node tools/drift/academy-login.mjs --check    # status only; never types anything
node tools/drift/academy-login.mjs --ensure   # sign in if needed: ONE attempt, no retries
```

Import-safe (`ensureAcademySession({profileDir, startUrl, timeoutMs, onLog, getPassword, login})`). Profile:
`.browser-profile-drift/` (dedicated; never the operator's `.browser-profile*`), headless, 1600x900, start
`https://app.hadrius.com/marketing/projects?company_id=1150`. The password is read at runtime from the login
Keychain (`/usr/bin/security find-generic-password -a stephen+hstudio@hadrius.com -s hadrius-studio-academy -w`,
`execFile`, no shell), passed straight to `locator.fill()` and dropped. No screenshots, tracing, video or HAR; refuses
to run with `DEBUG=pw:*`/`PWDEBUG`. Logs mask the account as `st***@hadrius.com`. Before typing, the page origin must
be the app origin or a Cognito hosted-UI origin (`/auth/sso` and known IdP hosts => `sso_redirect`, anything else =>
`unexpected`). After sign-in the tenant is checked passively from the app's own `GET users/?uuid=` response
(`user.company` tree, roles, staff flags): any company other than 1150, or staff access, or no payload => `tenant_mismatch`
(fail closed). Timeouts: 60 s per stage, 3 min total; the browser is always closed.

Exit codes: `already_signed_in` 0, `signed_in` 10, `not_signed_in` 20 (check mode), `mfa_required` 30,
`invalid_credentials` 31, `sso_redirect` 32, `captcha` 33, `keychain_missing` 34, `tenant_mismatch` 35,
`unexpected` 36, usage 64, crash 1. On 30/31/32/33 stop and get a human: do not re-run `--ensure` in a loop
(lockout risk).

**`.browser-profile-drift/` is not yet in `.gitignore`.** Add `.browser-profile-drift/` there before the first
real `--ensure`, otherwise the Hadrius session tokens in that profile could be committed.

Tests (synthetic local pages, injected fake password): `TMPDIR=$HOME/.hermes/cache/scratch node --test tests/drift/academy-login.test.mjs`

## Moved highlight (screen re-plan) + first/last slides (card crossfades), real pilot verified

```sh
TMPDIR=$HOME/.hermes/cache/scratch .venv/bin/python -m renderer.drift_render \
  --rebaseline-dir $TMPDIR/<rebaseline> --candidate-dir $TMPDIR/<candidate.mjs output> --slide-step-id <id> \
  --output $TMPDIR/NEW-dir --build-dir out/<name>/_build [--golden-build-dir out/<name>/_build] [--no-replan]
```

**Re-plan (`fx_draw.load_planner`).** A changed target, another screenshot size or a regrouped screen no longer stops
at `scope_expansion_required:*` (still available with `--no-replan` / `allow_replan=False`). assemble's own planner is
ast-extracted (`cam_fit, cam_views, fx_union, fx_area_zoom, fx_area_view, fx_plan, cam_caption_top` + the drawing
helpers) and the module-level planning sequence (`fit_slide_to_frame` loop, `cam_views`, `fx_plan`, `cam_caption_top`,
caption-run pass) is executed VERBATIM from the parsed source with its exact shape pinned (`unexpected_orchestration`).
`rep` is a `FrozenReport` that only answers `no_captions`/`caption_pos` (any other field raises at plan time) and
`args=()` (render.sh passes none). Unresolved globals fail closed as in `fx_draw.load`.
Golden first, on every run: re-planning the UNCHANGED script from the original captures must reproduce every persisted
`target/viewport/_cam/_fx/_cap_edges/_cap_text/_cap_top` exactly (`replan_golden_mismatch` otherwise). Dirty slides =
changed slide + every slide whose render-relevant plan differs (`fx_draw.render_view`: with FX on, only the size part
of `_cam` is drawn; `cam_views`' start view chains across screens when consecutive captures are byte-identical, which
is reported as `plan_only_differences`, not rendered). A regroup just expands the set (`screen_grouping_changed`); the
set must be one contiguous run (`fx_scope.explicit_scope`, else `scope_expansion_required:noncontiguous_scope`).
Other-size screenshots are handled by `fit_slide_to_frame` (16:9 pad + target shift) inside the re-plan.

**Edge slides + assemble chain (`--build-dir`).** First/last slides dissolve into the title/support cards
(crossfade_pair: lead clip `intro_title_crossfaded.mp4` -> content at `dur(lead)-0.65`, body -> `support_card.mp4` at
`dur(body)-0.65`, then -> `logo_card.mp4` at `dur(body_with_support)-0.8`; `dur` = FORMAT duration incl. audio, read
from the real intermediates). With the real `_build`, only the dirty slides are re-rendered; untouched segments and
cards are the real files (sha256 recorded; bound to the baseline by `<build>/../<name>.mp4` == manifest original
sha256, else `build_dir_not_baseline_source`), and assemble's stitch + crossfade chain runs with its own encoders
(video only). A control chain over the untouched segments must decode-equal the original final (`chain_golden`).
Missing intermediates (= concat fallback) -> `missing_build_artifact`; lead offset != `content_offset` ->
`card_timing_mismatch`; edge without `--build-dir` -> `unsupported_edge_slide`.

**Real pilot (`drift_render.real_pilot_replan_and_edges`; opt-in `HADRIUS_REAL_PILOT_DRIFT_RENDER=1`, ~8 min):**
- Card chain golden: crossfade_pair's exact calls (with audio) on the real `_build` inputs reproduce
  `intro_title_crossfaded`, `body_crossfaded`, `body_with_support` AND the final MP4 **sha256-identical**. Re-rendered
  seg01-03 (from the re-plan) + real cards -> all 810 final frames decode-identical (lead [162,184) and tail [589,611)
  PSNR inf); vs the lossy rebaseline those windows are PSNR min 46.93 / 50.65 dB, SSIM min 0.9981 / 0.9983.
- Re-plan golden: 3/3 slides, all 8 plan fields equal; re-planned seg01-03 bitstream-identical to `_build`.
- Moved highlight (slide 2 target -> the second project card, same pixels): dirty = slide-01 (`_fx`, shared screen
  camera) + slide-02 (`_fx`, `target`) = cells lead-dissolve..dissolve-02-03 = [162,461); 511 protected frames equal,
  audio packets/priming/PCM equal, 4 untouched cells byte-identical, changed frames [225,461) (225-313: x264
  lookahead/mbtree of the chain encodes before the first changed frame; slide-01 pixels change from its local frame
  122 = 30-frame lookahead before the camera move at 151). Camera centre moves 388.25 -> 541.75 (same zoom 1.37), so
  the callout stays at the same OUTPUT position; the element under it matches the new card crop (grey MAD 3.8-5.5 vs
  10.2-10.6 for the old card; baseline the reverse 1.9-3.9 vs 10.7-11.3).
- First slide (new screenshot): dirty [162,339) (lead-dissolve, hold-01, dissolve-01-02), 633 protected; last slide:
  dirty [435,611) (dissolve-02-03, hold-03, tail-dissolve), 634 protected; card frames outside the dissolves are
  protected and byte-identical cells. Banner diff ~100 grey inside its box vs ~0.35 outside.
- In every case the CONTROL cells (untouched inputs through the same chain, cut + encoded like the rebaseline) are
  byte-identical to the rebaseline's cells, i.e. donor cells differ from the baseline only by the change.

Limits: needs the baseline's real `_build` (render.sh wipes `out/<name>` on the next render) and a pinned caption font
layout; Extra FX + recording source only; clip slides, narration/caption/timing changes, multi-step candidates,
non-contiguous dirty sets and concat-fallback finals are rejected; local review artifact, not wired into the
bridge/extension/publisher; `assemble.py` unchanged.

## Weekly drift job: mutation guard, classification, runner (`classify.mjs`, `weekly.mjs`)

```sh
node tools/drift/weekly.mjs --once --names A,B | --allowlist FILE [--out NEW_DIR] [--dry-run] [--no-judge] [--timeout-min 15]
node tools/drift/classify.mjs --run RUN_DIR --script scripts/<name>.script.json --recordings out/_recordings/<id> [--no-judge]
```

**Capture changes.** Default profile `.browser-profile-drift`; before anything else `capture.mjs` runs the preflight
(bridge idle, no Chromium on the profile, no `SingletonLock`), then `ensureAcademySession()` (academy-login.mjs reads
the Keychain itself) with the SAME request guard attached (mode `auto_login`: Cognito auth + hosted UI pass, analytics /
Sentry / app writes do not). Any session status other than `already_signed_in`/`signed_in` => `session_failed`, nothing
captured. AI-slot profiles keep the legacy manual-sign-in path. Safe recorded clicks (and hovers, navigation keys) are
now replayed for buttons/menus/tabs too; CSS-only matches (recorded name gone) are never clicked (`target_renamed`).

**Mutation guard, click layer (`classifyStepMutation`).** Before any recorded click/press/type/upload, the recorded
name/text AND today's resolved element name are checked against data-changing words (save, submit, create, add, new,
delete, remove, archive, restore, (de)activate, sandbox, run, send, approve, reject, assign, publish, upload, import,
export/download, confirm, cancel, withdraw, request, share, sign out, ...; word-bounded, so `Approved`/`updated` don't
match; `Actions for <entity>` menu openers are judged by the head only). Typing, uploads, unknown/custom actions,
Enter/other non-navigation keys, toggle/selection roles (checkbox, switch, radio, option, ...), form-submit buttons,
file inputs and unnamed targets are also guarded. A guarded step gets its pre-action screenshot, is NOT performed, and
gets status **`needs_fixture`** plus `fixture` evidence (recorded action/key, target name/role/tag/css/text, today's
name/href, recorded and current page URL, record refs: numeric/uuid path segments named by the preceding segment,
`*_id` query params, the target href, a DOM row/data-id hint, and the entity named by an `Actions for X` opener on the
same or previous step). Every later non-navigate step is `needs_fixture` too; later `navigate` steps are captured by
direct GET with `prerequisiteUnverified:true`. `run.mutationPlan` holds the static plan (with fixture evidence) even
when the run stops earlier. This read-only stop remains the default for any video WITHOUT a reviewed fixture spec; videos
with one replay their data-changing steps on job-owned records (see "Fixture lifecycle" below).

**Mutation guard, network layer (`createRequestGuard({allow})`).** Separate exported function (pluggable allowlist:
`{method?, host?, path|pathRe}` or predicate, app hosts only). Every non-GET/HEAD (incl. OPTIONS) is logged with
method/host/path/decision/reason in `requests.json`. To `app.hadrius.com`/`hadriusapi.com` only auth/token refresh,
GraphQL queries, read-named POSTs (search/list/query/filter/count/lookup/get) and allowlisted entries pass; every other
non-GET is aborted in the browser AND fails the video (`run.status:'aborted'`, `run.aborted:'network_guard: METHOD
host/path (reason)'`, weekly job `aborted_mutating_request`). Exception: the page-view beacon
`POST hadriusapi.com/api/users/analytics/<id>/track-event/` is aborted but does not fail the video (it fires on every
page load). Third-party POSTs (Sentry, PostHog capture) are blocked; PostHog `/flags` reads pass.

**Classification (`classify.mjs`).** Per step, deterministic first: target missing/ambiguous, route change, click flow
change, viewport change, or a redesign (masked SSIM < 0.80, union of changed regions > 50% of the frame, or > 15% changed
pixels) => `full_rerecord`; CSS-only target => `narration_review`; target moved > 4 px => `moved_highlight`; other
screenshot change => `slide_update`. Persistent chrome = textured 16 px cells identical across every distinct recorded
frame on >= 2 routes (sidebar/header); a slide where > 20% of those cells changed is `chromeChanged`. For changed slides
with narration, the claude CLI (coverage-scan `runClaude`, Read tool only, `decisionModel()`) gets ONLY today's
screenshot + today's DOM text + the narration and must return `{accurate, claim_missing, reason, evidence,
suggested_rewrite}`: inaccurate => `narration_review`, claim no longer on screen => `full_rerecord`, judge unavailable =>
`narration_review`. (Given both frames it mixed them up and "saw" the recorded project ID on today's page.) The Gemini
fallback is suppressed for these calls (placeholder key, Gemini host refused) so it never reads `.env`. Video = worst
step; `needs_fixture`/uncaptured steps are `unverified` (`complete:false`), and if chrome changed while any slide would
be kept (unchanged/unverified) the video is `full_rerecord` (`mixed_old_new_ui`). Pilot run4 (Find-a-Project-ID):
`full_rerecord` (slide 2 target ambiguous; slide 3 SSIM 0.765 / 95.5% coverage + narration_contradicted: no project ID
on the page; sidebar changed on all 3 slides).

**Weekly runner (`weekly.mjs`).** Concurrency 1, per-video timeout (default 15 min), one failure never stops the run.
Per video under `<out>/<name>/`: `capture/` (run.json, requests.json, step PNGs, compare.json, diffs, contact sheet,
classify.json) and `job.json` (status, verdict, complete, summary, reasons, per-step classification with judge output,
mutation plan/stop, `needsFixture` evidence, all non-GET requests, evidence paths, candidate path, timings, errors);
`<out>/summary.json` for the run. For `slide_update`/`moved_highlight`/`narration_review` it writes a stable-ID local
copy (`identified-base.script.json`, sha256-derived v5-style IDs, so reruns reuse IDs), `candidate-manifest.json`
(geometry-only target change for moved highlights) and runs `createCandidate` into `<out>/<name>/candidate/`.
Scripts are read from `scripts/<name>.script.json` only (the library endpoint is not queried: `/library?name=` caches
into `scripts/`); `_studio*` names are refused; output must be new and outside the repo (default
`~/.hermes/cache/scratch/weekly-<stamp>`). `--dry-run` opens no browser and prints the static guard plan.

**Environment gaps are `unverified`, not drift.** A page still showing only a loading indicator after a 15 s extra
wait (`page_not_loaded`), an error page ("Couldn't load this document", "... not found": `page_error`), or a missing
target on an empty-state page that the judge also reports as `data_missing` (`record_not_visible`) leave the step
unverified. Live run 2026-10-29 (`~/.hermes/cache/scratch/weekly-20261029-063944`): the automation account sees 0
marketing projects (boards say "You are up to date"/"All projects are archived"; project 40513/40514 pages never load or
say "Marketing project not found"), so record-dependent steps are unverified; all three Academy marketing videos are
still `full_rerecord` because the redesigned sidebar changed on every slide (`mixed_old_new_ui`). The automation
account needs visibility of the recorded records (or job-owned fixtures) before these videos can be verified.
`How-to-archive-a-policy` was recorded in company 1048 and fails closed at the tenant check (`tenant_mismatch`), so its
Archive steps were only stopped by the static plan, not reached live.

**Scheduling.** See "Weekly schedule, bridge run/submit and PR-triggered early checks" below.

Tests: `TMPDIR=$HOME/.hermes/cache/scratch node --test tests/drift/*.test.mjs` (`capture.test.mjs`: click guard,
network guard + allowlist, fixture evidence, fake-browser replay that never clicks Archive and a fake write aborted at
the network layer; `classify.test.mjs`: rules, chrome detection, judge parsing, real run4 regression when present;
`weekly.test.mjs`: orchestration with injected fakes, failure isolation, timeout, candidate building, dry run).

## Combined updates: any number of changed steps, visual + narration, real ElevenLabs takes (`drift_update.py`)

```sh
TMPDIR=$HOME/.hermes/cache/scratch .venv/bin/python -m renderer.drift_update \
  --rebaseline-dir $TMPDIR/<rebaseline> --script <stable-ID script copy> --recordings-dir <dir named after recording.id> \
  --changes <approved change manifest> --build-dir out/<name>/_build --report out/<name>/report.json \
  --output $TMPDIR/NEW-dir [--take-mode elevenlabs|manifest|standin --allow-standin] [--dry-run]
TMPDIR=$HOME/.hermes/cache/scratch .venv/bin/python -m renderer.drift_update --real-pilot a|b|golden|noop \
  --rebaseline-dir $TMPDIR/<pilot rebaseline> --output $TMPDIR/NEW-dir
```

Change manifest (trusted LOCAL input, bound to the baseline manifest hash): `{baselineManifestHash, changes:[{stepId,
[screenshot:{path,sha256}], [target], [dpr], [narration:{oldText,newText,[newCaption],[take:{path,sha256,[source]}]}]}]}`.
`changes: []` returns the rebaseline final itself (no render, no remux). A change that re-applies the baseline's own
screenshot/target/narration+take is still rendered and reported under `golden_reapply`.

**One orchestrator, existing blocks.** Validation is pure (every rejection before any output). All visual changes go
through ONE `candidate.mjs` call (PNG checks, captureId, target-semantics guard); narration/caption is applied on top.
A preflight plan at baseline timing runs before any TTS spend. Then: per narration change `retime.quantize_sdur`; ONE
re-plan of the whole video through assemble's own planner (`fx_draw.load_planner`, gated on re-planning the UNCHANGED
script reproducing every persisted plan field); dirty = changed steps UNION every slide whose render-relevant plan
differs (so a re-timed slide's same-screen predecessors/followers, regroups and moved targets expand the set; any number
of non-adjacent runs); cells from `fx_scope.timeline` of the new assembly, mapped with `retime.map_cells`, reused cells'
camera views asserted unchanged (`retime.protected_views_equal`); every dirty slide rendered ONCE (`fx_draw`); assemble's
stitch + card chain on the real `_build` segments/cards; dirty cells cut + encoded in the rebaseline profile. No
narration change: splice + verify with `rebaseline.assemble_candidate`/`preservation` (complete audio bit-identical).
Narration change: reused cells copied byte-for-byte at shifted positions + ONE `audio_rebuild` soundtrack, verified
like `narration_update` (unchanged takes by cross-correlation at their shifted offsets, A/V sync deltas, captions).
This lifts the earlier rejections: multiple non-adjacent changed slides, visual+narration on one step, first/last-slide
narration (card crossfades re-run with audio), narration on a slide sharing a screen with later slides.

Goldens run on every update: audio (unchanged soundtrack packet-identical), re-plan, chain (control chain over the
untouched real segments decode-equals the original final; with narration also its crossfade offsets and audio
packets, and its `content.mp4` audio equals the real one), and control cells byte-identical to the rebaseline cells.

Two root causes found by those goldens (keep them):
- `content.mp4` must be built with assemble's ONE step-4 command (video copy + audio graph encode). Stream-copying a
  separately encoded content audio into it drops the AAC track's start offset (start_pts 1024 -> 0) and 160 samples, and
  every later crossfade's audio changes (`content_av_command`).
- `crossfade_pair` prints its offset `dur(c1) - xf` with `%.3f`, so a whole-frame shift can move a card start by one
  EXTRA frame (pilot: outro 24.5 s -> 26.7667 -> `26.767` starts the logo card 69 frames later for a 68-frame shift).
  `card_phase` predicts every chain boundary; the planner pads the last re-timed slide by <= 2 extra frames of pause until
  all boundaries shift by exactly the same amount (`card_phase_padding_frames`, else `card_phase_unresolvable`), so the
  tail card stays a byte-identical shifted cell. `chain_frame_count_mismatch` remains the backstop.

**Real takes (`renderer/take_provider.py`).** Runs `.venv/bin/python renderer/tts.py "<line>"` as a subprocess with env
`NARRATION_VOICE=<script.voice>`, cwd = repo, last stdout line = `{path, provider, cached}` (exactly the bridge's
`/preview/narration`). Requires provider `el`, a file `out/_cache/tts/el-<key>.mp3` whose key equals
`_key('el', normalize_pronunciation(line), '<voice id>|<model>')` (both functions + the default model literal AST-extracted
from tts.py, CLI fragments pinned; never imported), and decodable audio; else `voice_unavailable` with a reason
(`script_voice_not_elevenlabs`, `provider_not_elevenlabs`, `voice_id_mismatch`, `tts_failed`, `tts_output_unparsable`,
`take_outside_tts_cache`, ...). With real takes, the baseline takes must also be the cache names of their own narration in
the script voice (`verify_baseline_takes`, else `baseline_voice_unverified`). The take is copied into the job dir (sha256
pinned); characters = len(normalized line) when not cached. tts.py writes/touches `out/_cache/tts` like every preview;
nothing else is written under `out/`. The macOS `say` stand-in is tests-only (`--take-mode standin --allow-standin`).

Rejections (no MP4 written): `baseline_manifest_conflict`, `invalid_change_manifest`, `unknown_step`, `duplicate_change`,
`empty_change`, `old_text_mismatch`, `screenshot_hash_mismatch`, `missing_screenshot`, `unsupported_asset`,
`take_hash_mismatch`, `missing_take`, `take_required`, `unsupported_caption_only_change`, `unsupported_narration_removal`,
`unsupported_narration_addition`, `caption_conflicts_with_captionsFromNarration`, `unsupported_target_semantics_change`,
`invalid_geometry`, `inconsistent_audio_filter`, `unsupported_clip_slide`, `unsupported_non_fx_render`,
`script_needs_stable_step_ids`, `script_not_baseline`, `assembly_script_mismatch`, `recordings_dir_mismatch`,
`build_dir_required`, `build_dir_not_baseline_source`, `missing_build_artifact`, `card_timing_mismatch`,
`unsupported_card_topology`, `baseline_take_missing`, `replan_golden_mismatch`, `replan_failed_closed`,
`unrelated_step_changed`, `cell_topology_changed`, `reused_cell_length_changed`, `card_phase_unpredictable`,
`card_phase_unresolvable`, `scope_expansion_required:protected_camera_changed`, `voice_unavailable`,
`baseline_voice_unverified`, `candidate_rejected`; after rendering starts: `audio_golden_mismatch`,
`chain_golden_mismatch`, `chain_frame_count_mismatch`, `incompatible_replacement` (verification.json written).

**Real pilot (How-to-Find-a-Project-ID, 2026-10-29, local only; 35 real files sha256/size/mtime equal before/after):**
- (a) slide-01 banner + slide-03 LONGER narration, real ElevenLabs take `el:ZoiZ8fuDWInAcwPXaVeq`/`eleven_multilingual_v2`
  (102 chars, 5.20 s): dirty runs [slide-01] [slide-03], +39 frames (810 -> 849), 6 cells rendered, lead-card/hold-02/
  tail-card reused byte-identical and decode-equal at shifted positions; all goldens pass; takes at lag -785 (peaks
  0.961/0.965/0.979), sync delta 0.0 ms; 714 leading audio packets (15.2 s) identical to the baseline; banner diff 99-101
  inside its box vs 0.07-0.28 elsewhere (candidate vs original-screenshot control segment, same plan); faster-whisper
  small.en hears all 3 lines verbatim in their slots (recall 1.0), none of the old line's distinguishing words.
  `~/.hermes/cache/scratch/du-pilot-real-a-20261029/`.
- (b) slide-02 banner + SHORTER narration "Open the project." (17 chars, 1.16 s): screen re-plan makes slide-01 dirty too
  (`_fx`: keys/span), -54 frames (-> 756), 5 cells rendered, lead-card/hold-03/tail-dissolve/tail-card reused; banner
  78-102 vs 0.19-0.32; transcript recall 1.0, old line not heard. `~/.hermes/cache/scratch/du-pilot-real-b-20261029/`.
- golden re-apply (slide-01 original screenshot, slide-02 original target, slide-03 narration + its baseline take):
  7 cells rendered, candidate **sha256-identical** to the rebaseline final (0 differing frames, audio packets equal).
- noop: returns `baseline-rebuilt.mp4` (sha256 fec0626b...), nothing written but verification.json.
- Stand-in pilot runs (0 characters) found the card-phase issue: a 68-frame shift padded to 69.

Tests: `tests/renderer/test_drift_update.py` (4-slide synthetic fixture planned by assemble's planner and built by
assemble's chain WITH audio: scope union, multi-run, same-step combo, first/last-slide narration, card-phase padding,
reason codes, provider failure, full renders incl. golden re-apply and no-op) and `tests/renderer/test_take_provider.py`
(fake tts.py subprocess contract, provider/voice mismatch, pilot cache-name golden). Real pilot opt-in:
`HADRIUS_REAL_PILOT_DRIFT_UPDATE=1` (cached lines cost 0 characters).

Limits: LOCAL review artifact, never uploaded; protected cells are the lossy rebaseline. A narration change uses
assemble's exact re-plan, so earlier slides on the same screen are re-rendered (narration_update's frozen-span policy is
not used here); sdur is rounded up to whole frames plus <= 2 frames of card-phase padding (<= 0.1 s extra pause); the
whole soundtrack is re-encoded once (4 AAC generations); reused cells keep the baseline's sub-ms blend phase. Still
rejected: caption-only edits, adding/removing narration, structural changes (add/remove/reorder steps), clip slides,
non-FX renders, report flags beyond `caption_pos`/`no_captions`, non-ElevenLabs script voices. Needs the baseline's real
`_build` and a pinned font layout. Not wired into the bridge/extension/publisher; `assemble.py`/`tts.py` unchanged.

## Slack approval for drift updates (`jobs.mjs`, `slack.mjs`)

Version 1 never updates a video without a human. Each weekly finding becomes a **drift job** in the shared service
(webhook-service `api/studio-drift.ts`, Neon table `studio_drift_jobs`), posted to Slack channel `C0CD42Y6RU6` by the
"Hadrius Studio" app and mirrored in the panel's **Updates** modal. Setup: `SLACK_SETUP.md`.

- `jobs.mjs` (import-safe): `createJobsClient({baseUrl, getSecret})` (`create` idempotent per video+fingerprint,
  `list`, `get`, `decide` CAS, `progress`, `attachSlack`; errors carry `code`: `not_configured`, `service_missing`,
  `unauthorized`, `conflict`), `serviceUrlFrom(STUDIO_LIBRARY_URL)` and `buildJobDetails({weeklyJob, script, links, prs,
  proposedNarration, slideDurations, oldDurationSec})`, which turns a `weekly.mjs` job.json into the job payload: per-step
  change types (screenshot / highlight / narration), plain-English reasons, old vs new narration, before/after evidence
  paths, untouched steps, ≈% frames preserved, old→new duration and ElevenLabs characters.
  Kind: `full_rerecord`, or a `narration_review` step without proposed replacement text, or a failed candidate →
  `manual_rerecord`; otherwise `auto_update`. The fingerprint hashes video + kind + per-step change types/reason codes +
  proposed narration (not screenshot bytes or run paths), so next week's run maps the same drift to the same job.
- `slack.mjs`: `buildDriftMessage(job)` (pure Block Kit, ≤ 48 blocks; steps that don't fit go to thread replies),
  `createSlackClient({getToken})` and `postDriftJob` / `submitDriftJob`: post the message, record `ts` + blocks on the
  job (the service rebuilds the message from them after a decision), then upload each changed step's before/after PNGs
  into the thread (`files.getUploadURLExternal` → upload → `files.completeUploadExternal`). Image failures are returned
  in `errors`, never block the approval message. A job already posted (`slack_ts` set) is not re-posted.
- Decisions: auto_update → Approve / Deny (Slack deny asks for an optional reason in a modal); manual_rerecord →
  "I'll re-record it" (claim) / Mark re-recorded / Dismiss. Anyone in the channel or with the panel may decide; the
  service applies them with compare-and-set (first wins, later clicks get "Already approved by …"), then edits the Slack
  message (details kept, buttons replaced by a status line) and replies in its thread, including for panel decisions.
- Bridge (`tools/ai-bridge.mjs`): `GET /drift/jobs`, `POST /drift/jobs/:id/decision {decision, note, expectedVersion}`
  (by = `STUDIO_USER`, via = extension), `GET /drift/jobs/:id/evidence/:step/before|after` (PNG only, only from the drift
  scratch dir or `out/`), `GET /drift/review?id=` (the Slack "Open in Studio" target), internal
  `submitDriftJob(jobDetails, evidencePaths)` (called by `POST /drift/weekly/submit`, below); executing approved jobs: see "Executing approved
  jobs" below (`DRIFT_JOBS_EXECUTE=1`; the old `DRIFT_JOBS_POLL` logging stub is gone). Service missing/unconfigured → 503 with a plain message.

Tests: `tests/drift/jobs.test.mjs`, `tests/drift/slack.test.mjs` (no network; fake fetch). Service tests:
`cd ~/webhook-service && npm test` (`test/studio-drift.test.ts`: signatures, channel restriction, CAS races, transitions,
idempotent create, Slack message rebuild).

## Weekly schedule, bridge run/submit and PR-triggered early checks (`weekly-runner.mjs`, `weekly-submit.mjs`, `schedule/`)

Everything goes through the bridge so secrets stay in its process: the launchd agent and the PR trigger only ask the
bridge to run; the bridge spawns `weekly.mjs` (unchanged: read-only, fixture-guarded capture) with a **scrubbed env**
(no `STUDIO_*`/`SLACK_*`/`GOOGLE_*`/`PYLON_*`/`*TOKEN*`/`*SECRET*`/`*KEY`), then submits the run itself.
**Every entry point defaults to DRY RUN**; jobs are created / Slack is posted only with an explicit `dryRun:false`.

```sh
# run weekly.mjs (child, concurrency 1) then submit; 202 immediately, 409 if a run is active
curl -X POST localhost:8787/drift/weekly/run -H 'Content-Type: application/json' \
  -d '{"names":["How-to-Find-a-Project-ID"],"dryRun":true}'      # or {"allowlist":"tools/drift/allowlist.json"}
curl localhost:8787/drift/weekly/status                            # current/last run, submit counts, PR queue
# submit an existing run dir (weekly-* directly under ~/.hermes/cache/scratch)
curl -X POST localhost:8787/drift/weekly/submit -d '{"runDir":"'$HOME'/.hermes/cache/scratch/weekly-…","dryRun":true}'
```

- **Run** (`createWeeklyRunner`): lock file `~/.hermes/cache/scratch/drift-weekly.lock` (pid; stale locks taken over),
  overall timeout `videos x 16 min + 5 min` (max 12 h; SIGTERM then SIGKILL), child output appended to
  `~/Library/Logs/kbstudio-drift-weekly.log`. The lock also stores the run + child pid, so a bridge restarted
  mid-run adopts the orphaned child at startup (`recover()`) and submits when it exits. Extra body fields: `captureDryRun` (weekly `--dry-run`, no browser, no
  submit), `noJudge`, `source` (`schedule`/`pr`/`manual`, used in the run dir name `weekly-<stamp>-<source>`).
  `allowlist` only accepts `tools/drift/allowlist.json`.
- **Submit** (`prepareSubmissions` -> `jobs.buildJobDetails`): per video `job.json` + `scripts/<name>.script.json`
  (Drive/Pylon links), `out/<name>/assembly.json` (per-step `sdur`, duration) and the judge's `suggested_rewrite` for
  `narration_inaccurate` steps (never for `data_missing`/`claim_missing`). Decisions:
  `post` | `blocked_account_visibility` ("blocked: automation account can't see records": the only findings are
  `record_not_visible`/`page_not_loaded`/`data_missing`/`page_error`, no UI-change evidence) | `skip` (unchanged, capture
  failed/tenant mismatch, script missing) | `duplicate`. UI-change evidence = a changed step with a non-account reason,
  or a changed sidebar/header (`chromeChanged`) — chrome-only slides are added as evidence steps so reviewers see
  before/after. Account-unverified steps are listed in the message (`details.accountLimited`) and flagged when the
  re-record verdict depends on them (`mixed_old_new_ui` with only account-unverified kept slides).
- **Dedupe**: the fingerprint ignores the judge's rewrite wording (model output differs every run) and run paths, so a
  rerun maps to the same job; the service refuses a second blocking job per video+fingerprint; before posting the bridge
  lists the latest 200 jobs and also skips a video that already has an OPEN job under an older fingerprint (no second
  thread). A live submit refuses to run if that list fails.
- **Reports** in the run dir: `submit-dry-run.{json,md}` (dry run: exact Block Kit payloads as `slackMessage`, a
  readable `slackText`, the job payloads) or `submit-<stamp>.{json,md}` (live: job ids, Slack ts, errors).
- **PR trigger** (off by default): `DRIFT_PR_TRIGGER=1` in `.env` (bridge restart) queues allowlisted videos that
  `pr-watch.mjs` flags (`runPrWatch` now returns `flaggedScripts`) in `out/_drift-early-queue.json`; every 5 min a batch is
  released once 30 min passed without new flags, max 6 videos/day, each video at most once/day, never while a run is
  active (requeued if the start fails). Early runs submit as dry runs; `DRIFT_PR_TRIGGER=post` makes them live.
  Non-allowlisted (Sandbox/unknown tenant) names are recorded as `not_in_allowlist`.
- **Allowlist** `tools/drift/allowlist.json`: the 41 scripts whose `environment.startUrl` has `company_id=1150` (of 216
  local scripts: 109 are company 1048, 66 have no company). Regenerate after the library changes.
- **Schedule**: `tools/drift/schedule/com.kbstudio.drift-weekly.plist.template` rendered by `render-plist.mjs`
  (Monday 06:00 local, `curl` to `/drift/weekly/run` with the allowlist, `dryRun:true` unless `--live`; log
  `~/Library/Logs/kbstudio-drift-weekly.log`). `install.sh` writes `~/Library/LaunchAgents/com.kbstudio.drift-weekly.plist`
  and **disables** it (`launchctl disable`, not bootstrapped); `install.sh --enable [--live]` enables + loads it;
  `uninstall.sh` unloads and removes it. Check: `launchctl print-disabled gui/$(id -u) | grep drift-weekly`.
  The bridge must be running at fire time (it is a KeepAlive agent); a missed fire while asleep runs at wake.

Tests: `tests/drift/weekly-submit.test.mjs` (visibility-only blocking, chrome evidence, proposed narration, stable
fingerprint, dedupe, real 2026-10-29 run when present), `tests/drift/weekly-schedule.test.mjs` (runner lock/concurrency/
timeout/env scrub with a fake spawn, PR queue debounce/cap/allowlist/requeue, plist rendering + `plutil -lint`, allowlist).

## Executing approved jobs (`executor.mjs`, `publish.mjs`)

Off by default. With `DRIFT_JOBS_EXECUTE=1` in the bridge env, the bridge polls the service every 10 min
(`pollOnce`: `approved` auto_update jobs, oldest first, plus its OWN interrupted `in_progress` jobs) and executes one at a
time (lock `~/.hermes/cache/scratch/drift-exec/executor.lock`; a lock whose pid is dead or older than 4 h is stale; a
running render skips the tick). Failed jobs are never retried automatically.

Per job (`executeJob`), state in `drift-exec/<job id>/attempt-N/journal.json`:
1. **Claim**: PATCH progress `approved -> in_progress` with `expectedVersion` (409 = someone else claimed it -> skip).
2. **Inputs** (`resolveInputs`): `job.details.execution` = `{schema:1, scriptName, weeklyDir?, identifiedScript?,
   candidateManifest?, changeManifest?, rebaselineDir?, buildDir?, recordingsDir?, reportPath?}`. Without it, `weeklyDir`
   is the folder holding `job.json` + `identified-base.script.json` above a change's evidence path; recordings =
   `out/_recordings/<recording.id>`, build = `out/<name>/_build` (required), report = `out/<name>/report.json`.
   **Weekly submitters should set `details.execution.weeklyDir` (and `rebaselineDir` when one exists).**
3. **Change manifest** (`buildChangeManifest`), only from what was approved: screenshot/target changes from the weekly
   `candidate-manifest.json` (every step must be in `details.changes`, and the PNG must be byte-identical to the approved
   "after" evidence: `approved_evidence_mismatch`), narration from `details.changes[].newNarration` (`oldText` must equal
   the script). Bound to the rebaseline's `baseline-manifest.json` sha256.
4. **Rebaseline** when none is given: `renderer.rebaseline` into the attempt dir (disclosed lossy re-encode, said in Slack
   and recorded as `rebaselineBuilt`).
5. **Render** `renderer.drift_update` (ElevenLabs take mode, 75 min timeout) and `checkVerification`: `ok:true`, not a
   dry run, not a no-op, candidate sha256 matches, `source_unchanged`. Frames preserved % = reused cells / new frames.
6. **Publish** (`publishCandidate`), preflight first, all read-only, so a block writes nothing:
   - Drive: file exists, not trashed; its md5 must equal `out/<name>/<name>.mp4` (the rebaseline's original), else
     `drive_content_changed_since_baseline`. Never created, never found by name.
   - Pylon: GET the article; published + non-empty draft different from the published body = `pylon_pending_draft`;
     review `needs_review`/`changes_requested` = `pylon_pending_review`; exactly one `<video src>` (else
     `no_video_embed` / `ambiguous_video_embed` / `unsupported_video_markup`); no `<video>` but a link to the same Drive
     id = `drive_link` (nothing to edit).
   - Library: the shared script's steps (ignoring stable `id`s) must equal the identified base
     (`script_changed_since_detection`); the candidate may differ only in `steps`/`recording`.
   Then in order: **Drive** (head revision `keepForever:true`, `files.update` media upload, read-back: same id/name/parents,
   md5 = candidate, new head revision, permissions identical, previous revision still kept) -> **Pylon** (upload the
   MP4 as an attachment, swap ONLY the src value, prefix/suffix asserted byte-identical, `PATCH {body_html,
   publish_updated_body_html:true}` for published articles or `{body_html}` for drafts, never `is_published`; read-back
   equals the new body, no pending draft left) -> **library** (new captures copied to `out/_recordings/<new id>` and
   Drive `_recordings`, previous library + local script saved as `prev-*-script.json`, `POST` script with
   `driftUpdate:{jobId,...}`, read-back, local `scripts/<name>.script.json` updated).
   Any failure after a write rolls back what was attempted (library -> Pylon -> Drive) and reports it.
7. **Finish**: `published` with links `{drive, pylon, undo}` or `failed` with `stage: reason`.

Slack: notes go to the job's thread via the service (`POST ?action=note`) — started (+rebaseline disclosure), verified
(frames preserved, old -> new duration, ElevenLabs characters), published (links + "↩️ Undo update" =
`/api/studio-open?job=<id>`), or failed (stage, reason, what was / wasn't changed, rollback result). While the deployed
service predates `action=note` (400), notes are posted directly with the Studio bot token. Progress PATCH replies now quote
the executor's note (service change, tested, **not deployed**).

Crash safety: every remote write is journaled before (intent) and after (done). A re-run of our own `in_progress` job
reuses a verified render and reconciles by read-back: Drive md5 already = candidate -> verify instead of re-upload;
Pylon body already = expected -> done; library `driftUpdate.jobId` = this job -> done. If the job finished locally but
the final PATCH was lost, only the status is re-sent.

**Undo** (`rollbackJob`, bridge `POST /drift/jobs/:id/rollback`, panel Updates card "↩️ Undo update" on published jobs
that have a local record; `GET /drift/jobs` adds `local:{canRollback, rolledBackAt}`): restores the shared + local
script, the previous Pylon body (published again if it was published), and the Drive file (downloads the kept-forever
revision, checks its md5, uploads it as new content of the same id, verifies md5/id/name/permissions). Each step first
checks the destination still holds what was published; later edits are reported as conflicts and never overwritten.
Only the machine that executed the job holds the rollback record. New `_recordings/<id>` captures are left (additive).

Live checks (2026-10-29): Drive replace + keepForever + restore on a throwaway file in a new "[Studio QA] drift publish
test" folder (deleted afterwards); read-only Pylon dry run on a real published article (diff touches only the video src,
40 bytes kept before, 2431 after); full executor on synthetic approved routing-check jobs with the real service + Slack
thread and a real `drift_update` render of the pilot, Drive/Pylon/library faked.

Tests: `tests/drift/publish.test.mjs` (body edit, pending draft/review, baseline/script guards, Drive/Pylon/library
failures with rollback, crash after upload / after PATCH, rollback conflicts) and `tests/drift/executor.test.mjs`
(claim race, verification failure, Pylon-after-Drive failure, pending draft, crash + resume, note fallback, rebaseline
build, manual rollback once, manifest guards, lock, poll); fakes in `tests/drift/publish-fakes.mjs`.

## Fixture lifecycle: replaying data-changing steps on job-owned '[Studio QA]' records (`fixtures.mjs`, `journal.mjs`)

```sh
node tools/drift/fixtures.mjs --run --script scripts/<name>.script.json [--spec SPEC] [--out NEW_DIR]   # reconcile+sweep, replay, teardown
node tools/drift/fixtures.mjs --reconcile        # reconcile unfinished runs + 24 h sweep only (no replay)
node tools/drift/fixtures.mjs --status           # journal state per run
node tools/drift/fixtures.mjs --draft --script S --requests RUN/requests.json [--out spec.json]   # DRAFT spec, unreviewed
```

Academy prod (company 1150) only, automation account + `.browser-profile-drift` (same preflight/sign-in/tenant check as
`capture.mjs`; `captureRun({fixture})` is the integration point for `weekly.mjs`). A single-runner lock
(`out/_drift-fixtures/journal/fixtures.lock`, stale when its pid is dead) prevents overlapping runs.

**Spec** (`tools/drift/fixture-specs/<video>.fixture.json`, reviewed once; `reviewed:{by,at}` required, unreviewed or
invalid specs are refused): `labelKey`, `companyId:1150`, `apiHost`, `recordTypes` (`list`/`item`/`create`/`cleanup` paths,
all `/api/company/{companyId}/...`, `{fixtureId}` in item/cleanup, `nameField`), `fixtures` (`key`, `recordType`, `name`
starting with `{label}`, `create:{via:'ui', steps:[i]}` or `{via:'api', body}`), `steps` (`ui_only` | `type` (value
template `{fixture.<key>.name}` / `{recorded}`) | `set_slider` (spec selector, exactly one match) | `create` | `mutate`
(`expectedRequest.pathPattern` must contain `{fixtureId}`), `reversible`, `undo`, `effect:'confined'|'unconfined'`,
`verify`), `cleanupOrder`, `postconditions`. Label: `[Studio QA] <labelKey> <runId>`, runId = `YYYYMMDDTHHMMSSZ-xxxxxx`
(the sweep ages records by it). Every statically mutating script step must be in the spec, otherwise the replay stops
there as before (`needs_fixture`); `effect:'unconfined'` steps are `needs_human`, never performed.

**Network layer (fixture mode).** `fixtureAllow(spec, state)` is added to `createRequestGuard({allow})` (predicates now
receive `postData` and may return a reason). On the API host only, a non-GET passes when it is (a) the fixture's own
create request — right method/path, during that fixture's create step (or setup phase for `via:'api'`), body name field
EXACTLY equal to the run's labelled name, at most once — or (b) on an item/cleanup path of that record type whose
`{fixtureId}` is one of this run's ids (or ids journaled/found during reconcile/sweep). Everything else follows the old
rules: aborted and fails the run (telemetry beacon aborted without failing). Every non-GET is logged in `requests.json`
with `step` (`prepare`/index/`teardown`), decision and reason (`fixture_create:<key>`, `fixture_id:<type>:<id>`).

**API calls from the page.** Reconcile/sweep/verify/cleanup use the same REST endpoints as the app, issued by
`page.evaluate` inside the signed-in page. An init script remembers the app's own `jwt` request header in a closure and
exposes `window.__studioFixtureApi(method, path, body)` returning only `{status, json}`; the header never reaches Node,
logs or files. These calls go through the same route guard. Ids are read from create responses by the labelled name
(the firm-oversight endpoints answer with the whole list), else by listing.

**Journal** (`out/_drift-fixtures/journal/<runId>.jsonl`, gitignored via `out/`): `run_begin`, `create_intent` (name +
label BEFORE the click/API call), `created` (id), `verified_present`, `mutate_intent`/`mutated`, `cleanup_intent`,
`cleaned`, `verified_absent`, `run_end`. Each line is fsync'd; a torn last line is ignored and terminated before the
next append. A run is open while it has no `run_end` or any fixture with a create intent is not `verified_absent`.
Order of every run: tenant check on the start page -> **reconcile** open runs (delete by journaled id, or find by the
unique name when the crash came before the id; verify absent; `run_end reconciled`) -> **sweep** (`[Studio QA]` records of
the specs' types whose label is > 24 h old and whose run is not open; unparsable labels reported as `unknown_age`, never
deleted) -> replay (journal before each create/mutate) -> teardown in `captureRun`'s `finally` (also after errors and
network-guard aborts) -> `run_end` (`*_dirty` if anything could not be verified absent).

**Live pilot (2026-10-29, `How-to-Populate-Controls-and-Risks-Manually`, Testing program > Risks/Controls).** Endpoints
observed live: `POST .../firm_oversight/risks/` `{scenario, inherent_risk_impact, ...}`, `POST .../controls/`
`{display_name, ...}`, row-menu Delete -> `DELETE .../risks/{id}/`, `.../controls/{id}/` (hard delete; item GET is 405, so
presence is checked on the list). Records have no `created_by`: ownership = unique label + journal + this run's create
response. Effect is confined (unlinked risk/control, no recipients). Today's risk form refuses to create without an
impact, which the recording set during a "hover" (value 2 visible in step 4's media): spec `set_slider`.
- run `20261029T115859Z-typud3`: step 2's field name check failed (capture's re-check did not know form-field labels; fixed),
  so the risk create went out with an empty scenario and the guard ABORTED it (`unclassified_app_post`); nothing created.
- run `20261029T120041Z-wootjk`: all 12 slides captured; risk 48743 + control 51780 created by the walkthrough's own clicks
  (`fixture_create:*`), verified listed, deleted (`fixture_id:*`, 200), verified absent; journal 14 entries, `run_end captured`.
- crash run `20261029T120406Z-qir6c3` (`--simulate-crash-after-step 4`, SIGKILL): risk 48744 left, journal open; Chromium
  exited with the parent (no `SingletonLock`). Next run `20261029T120600Z-o0vzrp` reconciled it first (`prepare DELETE
  .../risks/48744/` allowlisted from the journal, verified absent, `run_end reconciled`), then replayed and cleaned 48745/51781.
- Afterwards: 0 `[Studio QA]` risks/controls; list counts back to 26 risks / 23 controls.

Limits: compare/classify still see the labelled names typed into the form and listed in the registers as screenshot
changes (re-record such videos once on fixtures before relying on weekly comparisons); while a run is active (~2 min)
its records are visible to teammates (e.g. in the control dialog's "Associated risks"). `via:'api'` setup, `mutate`
steps (guard path only) and the sweep's delete path are unit-tested with fakes only (the pilot creates its records
through the UI and there were no > 24 h leftovers). Rewriting recorded record ids in step URLs to fixture ids (needed for
walkthroughs that open an existing record, e.g. a marketing project) is NOT implemented yet. The read-named-POST/GraphQL-query allowances of the base
guard still apply in fixture mode. Not yet called by `weekly.mjs`.

Tests: `tests/drift/fixtures.test.mjs` (labels/templates, spec validation, fixture guard on synthetic requests, page-API
init, journal torn line + lock, happy path, crash at EVERY journal write/backend op then reconcile (teammate records
kept), reconcile by name, sweep rules, draft, and `captureRun` in fixture mode with a fake browser: full replay +
teardown, a mis-click on a teammate record aborted at the network layer with teardown still cleaning, uncovered step stops).
