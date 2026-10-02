# Whitepaper reproduction

The paper's editable source is [WHITEPAPER.md](../WHITEPAPER.md); the committed reading copy is
[WHITEPAPER.pdf](../WHITEPAPER.pdf). Its protocol baseline is `2e9ed05`; T6 adds documentation and these
offline tools without changing contract, indexer or terminal code. Run commands from the repository root.

## Recompute the numbers

```bash
node scripts/whitepaper-facts.mjs > /tmp/wuji-whitepaper-facts.json
diff -u docs/WHITEPAPER_FACTS.json /tmp/wuji-whitepaper-facts.json
node --test indexer/bitcoin.test.mjs
forge test --root contracts
```

The calculator uses Node built-ins only and makes no network requests. It reads Solidity constants, the
two public v3 deployment manifests and real Bitcoin fixtures. It independently hashes height 800000,
checks the raw/explorer byte-order vector, counts fixture headers and calculates the stated conditional
variance and operating-budget scenario. Floating-point output is approximate; the path vector and wad
increment use exact byte/BigInt operations. This reproduces the paper's arithmetic, not a proof that real
block outcomes are unbiased, independent or tradable at the displayed share.

`docs/WHITEPAPER_FACTS.json` is committed output. Regenerate it only after checking source/parameter changes
and revise the paper if its values no longer agree. Protocol changes also require their normal review and tests.

## Render the six-page PDF

Rendering is optional documentation tooling, separate from the zero-dependency runtime. The checked copy was
generated on 2026-10-02 with Python 3.9.6, ReportLab 4.4.9, pypdf 6.10.0 and macOS Arial Unicode TTF (the
2026-09-21 copy used Python 3.12.14 with the same libraries). The renderer requires
ReportLab and pypdf in the selected Python environment; it does not install packages or download fonts.

```bash
WUJI_PDF_FONT='/path/to/chinese-font.ttf' python3 docs/tools/render-whitepaper.py
# Optional separate output for checking a rendering without replacing the committed copy:
WUJI_PDF_FONT='/path/to/chinese-font.ttf' python3 docs/tools/render-whitepaper.py /tmp/wuji-whitepaper.pdf
```

On macOS the default font path is `/System/Library/Fonts/Supplemental/Arial Unicode.ttf`. Use a font whose
licence permits embedding and which covers Chinese, Latin and mathematical symbols. A different font or
library version can change line breaks and PDF bytes. Same inputs and rendering environment are deterministic.

The script supports the limited Markdown constructs used in this paper, rather than arbitrary Markdown.
Five explicit page-break comments define six authored pages. Rendering fails if text overflows six pages,
essential text is missing or no TrueType font is embedded. Visually inspect all six pages after edits, including
mathematical symbols and the long hash vector; text extraction alone does not establish correct appearance.
Each footer carries the first 12 characters of the Markdown SHA-256 to identify its source. This is a content
identifier, not a signature or audit approval. Relative links in the PDF require the accompanying repository;
the external bibliography links are directly usable.

See [T6_REPORT.md](../tasks/T6_REPORT.md) for verification and open items.
