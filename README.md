# 🎶 Air Harp

A harp-only edition of [Imaginary Instruments](https://github.com/jammaloo/ImaginaryInstruments)
(this branch, `harp-only`, carries just the one instrument; `main` has the
trombone, accordion, maracas, drums, harp and bass).

Play an invisible harp with your own hands. The harp hangs below your chin;
your webcam tracks all ten fingertips, and sweeping any fingertip across a
glowing string plucks it — with real Karplus-Strong string synthesis,
rendered locally in your browser. No video ever leaves your device.

- **Both hands are plectra**: sweep a fingertip *across* a string to pluck
  it. Sweep speed sets the volume; you must actually touch the strings.
- Real Karplus-Strong string synthesis (rendered per pitch and cached),
  so plucks genuinely ring and decay like strings.
- Mouse mode (`M`): sweep the pointer across the strings.
- `D` toggles a debug overlay; the 🔊 button mutes.

The harp plays C-major pentatonic (C4–A5), so sweeping wildly always
sounds musical.

## Controls

| Input | Action |
| --- | --- |
| `D` | debug overlay (landmarks, string state) |
| `M` | mouse mode (no camera needed) |
| Mouse mode | sweep the pointer across the strings to pluck |
| 🔊 button | mute |

## Try it

Open the live demo (GitHub Pages) or run locally:

```bash
# any static server works — camera access requires https or localhost
python3 -m http.server 8000
# then visit http://localhost:8000
```

First load downloads the MediaPipe tracking models (~15 MB) — the download
starts the moment the page opens, so by the time you click "Start" the
camera comes up almost instantly. Models are cached for future visits.
Works best in Chrome/Edge/Safari on a desktop or laptop with a webcam.

## Performance

The app adapts to your machine. A quality governor watches the render fps
and steps between three tiers — trading canvas size, glow/shadow effects,
and face-inference rate — to keep the loop smooth; the `D` debug overlay
shows the current tier. Camera capture runs at 640×480 (plenty for
tracking), hands are detected every frame, and the face every other frame.
If the GPU tracker stalls on your browser, it automatically rebuilds on the
CPU and drops to the leanest tier (the status pill shows "· CPU").

## How it works

- **Tracking** — [MediaPipe Tasks Vision](https://developers.google.com/mediapipe)
  (`FaceLandmarker` + `HandLandmarker`) running per video frame on the GPU.
  The face supplies the mouth anchor, a jaw-open "blow" signal (from face
  blendshapes), and an eye-distance reference used to scale everything.
- **Mapping** — key points are exponentially smoothed, then mapped to
  instrument parameters measured in "eye widths" so the instrument keeps a
  consistent size as you lean in or out.
- **Sound** — synthesized from oscillators: the trombone is a pair of
  detuned sawtooths through a pitch-tracking lowpass (brass-ish) with
  vibrato; the accordion is a bank of detuned "reeds" (16′ sub, two musette
  reeds ±8¢, 4′ octave) whose volume follows bellows speed.
- **Overlay** — a 2D canvas layered exactly over the (mirrored) video draws
  the trombone/slide and the accordion with its folding bellows, scaling with
  your face.

## Project layout

```
index.html      — page shell, start panel, HUD
style.css       — all styling
src/main.js     — app state, input mapping, game loop
src/tracking.js — camera + MediaPipe wrappers
src/audio.js    — Web Audio synthesis (trombone & accordion voices)
src/draw.js     — canvas rendering of the instruments
```

## Privacy

Everything is client-side: the camera stream is never recorded or sent
anywhere, models are fetched once from Google's CDN, and the app works
offline after the first load (cache permitting).

## License

[MIT](LICENSE)
