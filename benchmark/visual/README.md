# Four-Simulator 2x2 tiler

This fail-closed macOS helper places the four benchmark Simulator windows in
one fixed layout:

| Cell | Arm | Setup |
| --- | --- | --- |
| top-left | A | `CODEX + UITEST` |
| top-right | B | `CODEX + PREVIEWS` |
| bottom-left | C | `CODEX + INJECTION` |
| bottom-right | D | `CODEX + MOOPS + CLAUDEMEM` |

It has no `1x4` mode. The desktop region must have even dimensions so every
cell is exactly equal. Before returning success, it rereads all window titles
and frames through Accessibility and rejects missing, duplicate, or mismatched
target windows—including a one-pixel frame difference. Unrelated Simulator
windows with other titles are left alone and ignored.

## Live runner invocation

Give the four Simulator devices unique window titles, then pass those exact
titles and the recording region:

```sh
node benchmark/visual/tile-simulators.mjs \
  --x 0 --y 0 --width 1920 --height 1080 \
  --a-title "MOOPS A UITEST" \
  --b-title "MOOPS B PREVIEWS" \
  --c-title "MOOPS C INJECTION" \
  --d-title "MOOPS D MEMORY" \
  --output /absolute/run/results/simulator-layout.json
```

The process exits nonzero and prints `ok: false` JSON on any failed check. On
success, stdout and the exclusive mode-`0600` output file contain the same
receipt with each expected and actual frame.

The receipt also records two macOS permission preflights:

- Accessibility is required and denied access fails the command.
- Screen Recording is checked with CoreGraphics and reported for the recorder;
  it does not gate window movement itself.

Grant the terminal or runner executable Accessibility and Screen Recording
access before the live demo. The helper never launches Simulator or any GUI
application; the benchmark runner owns their lifecycle.

## Tests

Tests inject a fake process executor and never touch the GUI:

```sh
cd benchmark/visual
npm test
```
