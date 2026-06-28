# docsnap

Browser-free CLI that turns public docs and text-heavy pages into clean Markdown corpora for coding agents.

docsnap uses static fetches, `llms.txt`, page links, sitemaps, RSS/Atom feeds, `rel=next`, scoped crawl, Markdown alternates, JS asset text mining, and inline-state extraction. It does not launch a browser and has no `--render` mode.

```bash
bunx docsnap https://react.dev/reference -m 8 --clean
```

The CLI prints progress, artifact paths, and local follow-up commands. It writes:

```text
docsnap/react-dev-reference/
  manifest.jsonl
  summary.json
  ...
```

docsnap works best on public sites with readable HTML, `llms.txt`, sitemaps, regular links, or extractable inline state.

## Install

```bash
bun add -g docsnap
```

## Usage

```text
docsnap <url> [flags]
docsnap fetch <url> [question] [flags]
docsnap refresh <corpus-dir> [flags]
docsnap list [root=./docsnap] [flags]
docsnap search <corpus-dir> <query> [flags]
docsnap search [root=./docsnap] <query> --all [flags]
docsnap mcp
```

Run `docsnap --help` or `docsnap <command> --help` for flags.

```bash
docsnap https://react.dev/reference
docsnap https://react.dev/reference/react/useEffect
docsnap fetch https://react.dev/reference/react/useEffect "cleanup function"
docsnap https://react.dev/reference/react/useEffect --site -m 20
docsnap refresh docsnap/react-dev-reference
docsnap list
docsnap search docsnap/react-dev-reference "effect cleanup"
docsnap search --all "effect cleanup"
docsnap https://docs.python.org -o ./python-docs -m 100
docsnap https://docs.djangoproject.com/en/stable/
```

## Notes

Specific page URLs auto-capture as one page unless `--site` or `-m`/`--max` asks for site discovery. Use an absolute `--out` path for output outside the current directory. With `--json`, captures return artifact paths plus command-oriented `commands` and `next_actions`.

`docsnap fetch <url> "question"` reuses an existing corpus, captures it if missing, and returns cited local Markdown context. Without `--out`, fetch checks `./docsnap` for a reusable corpus before recapturing. `--freshness refresh` re-checks the original seed, and `--freshness force` recaptures.

Use `rg` for raw local search speed. Use `docsnap search` when you want ranked local hits with source URLs, page titles, confidence, line spans, and expand commands. With `--all`, plain words are query text; pass a path-like or existing root first to search outside `./docsnap`.

```bash
docsnap list
rg -n --fixed-strings --ignore-case -g '*.md' -e signature -e verification -- docsnap/stripe-com-webhooks
docsnap search docsnap/stripe-com-webhooks "signature verification"
docsnap search --all "signature verification"
docsnap search docsnap "signature verification" --all
docsnap search docsnap/react-dev-reference -- "--yes"
```

`docsnap refresh <corpus-dir>` reruns a corpus from its `summary.json` seed URL and removes pages no longer in the manifest. Non-clean writes require a valid existing corpus or an empty output directory; use `--clean`, `docsnap fetch --freshness force`, or a new `-o` when an output folder is stale or mixed.

docsnap keeps a shared fetch cache in `~/.cache/docsnap`. Set `DOCSNAP_CACHE_DIR` to choose another cache directory, `DOCSNAP_CACHE_DIR=off` or `--no-cache` to bypass it, and `DOCSNAP_CACHE_MAX_MB` to change the cap.

## MCP

```bash
claude mcp add docsnap -- docsnap mcp
```

Tools:

- `docsnap_fetch`: capture, reuse, or refresh a URL and return ranked Markdown context with citations
- `docsnap_capture`: capture a public docs site or text-heavy page into a local corpus
- `docsnap_refresh`: rerun a corpus's seed URL and report new/changed/removed pages
- `docsnap_context_pack`: ranked answer-with-sources bundle for one corpus
- `docsnap_search_corpus`: ranked snippet search across a corpus
- `docsnap_read_page`: read a bounded slice of one captured page
- `docsnap_list_corpora` / `docsnap_list_pages`: discover captured corpora and pages
- `docsnap_get_corpus_summary`: corpus health, failures, warnings, redirects

MCP resources expose known corpora's `summary.json`, `manifest.jsonl`, and bounded page Markdown for clients that browse resources.

## Output

- `manifest.jsonl`: one JSON record per retained attempt, including URLs, output paths, hashes, aliases, and failures when present
- `summary.json`: machine-readable truth for status, URLs, seed state, counts, failures, quality warnings, redirects, hashes, timing, refresh, and cache
- Markdown files: readable page captures with source metadata

Use `rg --files` or `find` when you need the file layout.

Captured page bodies are untrusted web data; failures and redirects are recorded in `summary.json`, `manifest.jsonl`, and page frontmatter.

## Requirements

- [Bun](https://bun.sh) runtime

## License

MIT
