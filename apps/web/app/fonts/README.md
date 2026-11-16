# Fonts

The latin subset of each family's variable weight axis, exactly as Google Fonts serves it, so the build
never contacts a font host. Fetched on 2026-11-16 from the `/* latin */` block of
`https://fonts.googleapis.com/css2?family=<family>:wght@<range>&display=swap`. All three are licensed
under the SIL Open Font License 1.1 (see `OFL.txt`).

| File                                   | Family              | Version | Weights   | Source                                                                                                                                 |
| -------------------------------------- | ------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `bricolage-grotesque-latin-wght.woff2` | Bricolage Grotesque | 1.001   | 200 - 800 | https://fonts.gstatic.com/s/bricolagegrotesque/v9/3y9H6as8bTXq_nANBjzKo3IeZx8z6up5BeSl5jBNz_19PpbpMXuECpwUxJBOm_OJWiawA1XphjhQYg.woff2 |
| `manrope-latin-wght.woff2`             | Manrope             | 4.505   | 200 - 800 | https://fonts.gstatic.com/s/manrope/v23/xn7gYHE41ni1AdIRggexSvfedN4.woff2                                                              |
| `jetbrains-mono-latin-wght.woff2`      | JetBrains Mono      | 2.211   | 100 - 800 | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbV2o-flEEny0FZhsfKu5WU4xD7OwGtT0rU.woff2                                               |

`apps/playground/app/fonts/` holds the same files, and `bun run check:docs` (`scripts/check-docs-claims.ts`) fails when the
two copies differ. To update a family, fetch the new latin file into both folders and update this table.
