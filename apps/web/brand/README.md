# LumenWipe brand assets

Every logo, favicon, app icon and the web manifest come from one source: `brand/tokens.ts` (colors
and the mark) and `brand/brand.ts` (every variant). Do not edit an exported file by hand. Change
the source and run `bun run brand:assets` from `apps/web`; a unit test fails when a committed file
no longer matches it.

## Files

| File                                       | Use                                                |
| ------------------------------------------ | -------------------------------------------------- |
| `mark.svg`, `mark.png`                     | The mark alone, on a dark background               |
| `wordmark.svg`, `wordmark.png`             | Mark and word side by side, on a dark background   |
| `wordmark-light.svg`, `wordmark-light.png` | Mark and word side by side, on white or near white |
| `stacked.svg`, `stacked.png`               | Mark above the word, on a dark background          |
| `stacked-light.svg`, `stacked-light.png`   | Mark above the word, on white or near white        |
| `mono-white.svg`, `mono-white.png`         | One color, white, where only one color can be used |
| `mono-black.svg`, `mono-black.png`         | One color, black, where only one color can be used |
| `avatar.svg`, `avatar.png`                 | Square profile picture: the mark on ink, 512 px    |

The same source writes `public/favicon.svg`, `favicon.ico`, `favicon-96x96.png`,
`apple-touch-icon.png`, the `any` and `maskable` manifest icons, `public/site.webmanifest`, and
`docs/favicon.svg` and `docs/logo/{dark,light}.svg` for the documentation site.

## The one dark value

Ink is `#080D0F`: the page background (`--bg` in `app/globals.css`), the favicon fill, the
manifest `theme_color` and `background_color`, and `viewport.themeColor`. A unit test keeps all of
them equal.

## Clear space and minimum size

- **Clear space.** Keep an empty margin on every side of the logo of at least half the height of
  the mark: 16 px at the native 36 px height. No text, edge or other graphic enters it.
- **Minimum size, full logo.** 24 px tall (about 115 px wide). Below that the word stops being
  legible.
- **Minimum size, mark alone.** 16 px. Below that the arc and the star merge. Use the mark alone
  only where the full logo does not fit.
- The word never appears without the mark.

## The wordmark font

The word is outlined to paths once, so no file depends on a font being installed. Source:
Bricolage Grotesque Bold, font version 1.001, from the `@fontsource/bricolage-grotesque` 5.3.0
package (`bricolage-grotesque-latin-700-normal.woff`), originally
<https://github.com/ateliertriay/bricolage>. Copyright 2022 The Bricolage Grotesque Project
Authors, licensed under the SIL Open Font License 1.1 (<https://openfontlicense.org>). Set at 20
units with -0.6 letter spacing; the outlines are in `brand/wordmark-outline.ts`.
