# Noto Sans Thai (self-hosted subset)

Android WebView ships Noto Sans Thai as a system font; iOS WKWebView does not,
so every Thai glyph fell back to Arial on iPhone — wrong metrics, worse
legibility, and 100% of this app's copy is Thai. Hence self-hosting.

- **Source:** [google/fonts `ofl/notosansthai`](https://github.com/google/fonts/tree/main/ofl/notosansthai),
  `NotoSansThai[wdth,wght].ttf` (v29).
- **Build:** the variable font pinned to `wght` 400 / 700 at `wdth` 100
  (fontTools `instantiateVariableFont`), subset to Latin basic (U+0020–007E),
  the Thai block (U+0E00–0E7F), general punctuation (U+2000–206F) and the
  marks Thai shaping needs (U+00A0, U+25CC), then compressed to WOFF2.
  GSUB/GPOS are kept so Thai mark positioning still works. The unicode-range
  in `globals.css` must stay in step with this list.
- **Size:** ~14 KB per weight.
- **Licence:** SIL Open Font License 1.1 — see `OFL.txt`.

To regenerate after a font update, re-run the same pin → subset → WOFF2 steps
against the current upstream TTF.
