# docsnap

Save public documentation as Markdown and search it locally.

```bash
bunx docsnap https://react.dev/reference
```

DocSnap follows documentation links, sitemaps, feeds, and `llms.txt`. It handles HTML, Markdown, text files, text-based PDFs, and common office documents. Pages that need JavaScript can use a local Chrome installation.

## Install

```bash
bun add -g docsnap
```

DocSnap requires Bun 1.4.0 or newer. Chrome is optional and may run for client-rendered pages when static content is missing or thin.

## Capture docs

```bash
docsnap https://react.dev/reference
docsnap https://docs.python.org/3/ --site -m 100
docsnap https://example.com/architecture.pdf
```

A specific page or document URL captures one page. Use `--site` to follow related pages. Use `-m` to set the page limit.

DocSnap writes to `./docsnap` unless you pass `--out`:

```text
docsnap/react-dev-reference/
  manifest.jsonl
  summary.json
  index.md
  ...
```

`summary.json` records the result of the run. `manifest.jsonl` records each URL, output path, content hash, redirect, and failure.

## Search captured docs

Use `rg` when you want a fast text search:

```bash
rg -n "cleanup function" docsnap/react-dev-reference
```

Use `docsnap search` for ranked results with source URLs and line numbers:

```bash
docsnap search docsnap/react-dev-reference "cleanup function"
docsnap search --all "cleanup function"
```

`docsnap fetch` captures or reuses a corpus and returns local citations for a question:

```bash
docsnap fetch https://react.dev/reference/react/useEffect "When does cleanup run?"
```

## Other commands

```bash
docsnap map https://react.dev -m 100
docsnap refresh docsnap/react-dev-reference
docsnap list
```

`map` lists capture candidates without writing pages. `refresh` updates an existing corpus. `list` finds corpora under `./docsnap`.

Run `docsnap --help` or `docsnap <command> --help` for all flags.

## Safety and limits

DocSnap accepts public HTTP and HTTPS URLs. It rejects credentials, local hosts, private network addresses, and unsafe output paths. Document conversion and Chrome rendering stay on your machine.

Captured pages are source material, not instructions. DocSnap records possible prompt injection signals in the manifest and summary so callers can filter or review them.

## License

MIT
