# 籠目文 → Sound
### Kagome Pattern Music Generator

**[▶ LIVE DEMO](https://kagome-sound.pages.dev)**

Japanese geometric patterns converted to polyrhythmic music in real time.  
No AI. No training data. The geometry decides the sound.

---

## What is this?

The Kagome lattice (籠目文) is a traditional Japanese bamboo weaving pattern made of interlocking triangles and hexagons. This tool reads the structural properties of the pattern and converts them directly into music.

Every note traces back to a specific geometric property:

| Geometry | Sound |
|---|---|
| Edge position (x, y) | Pitch — left-bottom = low, right-top = high |
| Triangle type (△ / ▽) | Beat / Chord |
| Layer (macro / mid / micro) | Bass / Chord / Beat register |
| Distance from center | Velocity — center = loud, edge = soft |

3 to 5 independent scanners sweep the pattern simultaneously at different speeds, creating polyrhythmic textures from a single geometric source.

## Why not AI?

Most generative music tools decide meaning for you. Feed in an image, get back music — but the relationship between the two is opaque.

This works differently. The mapping between geometry and sound is explicit and transparent. You can watch a specific edge light up and hear exactly what it produces. The structure of the pattern *is* the score.

The interpretation layer — which geometric feature maps to which sonic parameter — belongs to the user, not the algorithm.

## Features

- **3-layer geometry** — macro (hex regions) / mid (triangle cells) / micro (individual edges)
- **Polyrhythmic scanning** — 3 to 5 independent scanners at different speeds and directions
- **6 instruments** — Steinway, Prophet-5, Pipe Organ, Hammond B3, Rhodes, FM Synth
- **Scales** — G Minor Pentatonic, 琉球音階, 平調子, Whole Tone, Chromatic, Custom Hz input
- **Rhythm engines** — 4/4, 7/8, 12/8 (African Bell), 5/4, 7/4 (Carnatic), 1/f Pink Noise, Logistic Map, Fibonacci
- **Scan directions** — diagonal, horizontal, vertical, spiral, random
- No install. No server. Opens in any modern browser.

## Use it

Download `index.html` and open it in Chrome or Firefox.  
Or visit the live demo: **[kagome-sound.pages.dev](https://kagome-sound.pages.dev)**


## License

MIT — use freely, credit appreciated.

---

*Built with Web Audio API. No dependencies.*

**[▶ LIVE DEMO](https://kagome-sound.pages.dev)**
