# docsnap

DocSnap takes a public URL and leaves a folder of Markdown for an agent.

```bash
bunx docsnap https://react.dev/reference
```

It can capture one page or follow a site, read `llms.txt` and sitemaps,
convert PDFs with PDF Inspector and other documents with AnyDoc, and render
JavaScript pages with local Chrome.

## Install

```bash
bun add -g docsnap
```

DocSnap runs on Bun 1.4.0 or newer; installed through npm without Bun, the CLI
explains what to install. Chrome is optional unless a page needs browser
rendering. PDF conversion is unavailable on Intel Macs.

## Capture

```bash
docsnap https://react.dev/reference
docsnap https://docs.python.org/3/ --site -m 100
docsnap https://example.com/architecture.pdf
```

A specific page or document URL captures one page. `--site` follows related
pages. `-m` sets the page limit.

If the output directory already contains another corpus, choose a different
path or pass `--clean` to replace it.

Keep only the paths you need:

```bash
docsnap https://example.com --site \
  --include '/docs/**' \
  --exclude '/docs/archive/**'
```

The supplied URL is always attempted. Filters apply to discovered pages, and
exclude wins.

Capture several URLs from stdin:

```bash
printf 'https://react.dev\nhttps://bun.com/docs\n' | docsnap --stdin --out docsnap
```

Each URL gets a separate corpus. The command returns one ordered JSON result.

## Map and refresh

```bash
docsnap map https://react.dev -m 100
docsnap refresh docsnap/react-dev-reference
```

`map` returns capture candidates without writing a corpus. `refresh` uses the
original URL and saved path filters. Its result includes change counts and the
paths that changed.

## Output

```text
docsnap/react-dev-reference/
  summary.json
  manifest.jsonl
  index.md
  ...
```

`summary.json` describes the run. `manifest.jsonl` records every page, output
path, source URL, content hash, redirect, and failure. The remaining files are
the captured Markdown.

Agents can inspect the corpus with ordinary file tools:

```bash
rg -n "cleanup function" docsnap/react-dev-reference
```

Every command returns one JSON result. `message` says what happened and `next`
says what to do. Failures exit nonzero.

Run `docsnap --help` for all flags.

## Safety

DocSnap accepts public HTTP and HTTPS URLs. It rejects credentials, local
hosts, private network addresses, and unsafe output paths. Document conversion
and Chrome rendering stay on your machine.

Scanned or image-only PDFs fail with the affected page numbers. The capture
path never opts in to AnyDoc's hosted OCR.

Captured text is untrusted source material.

## License

MIT
