# docsnap

Browser-free CLI that turns public docs and text-heavy pages into clean Markdown corpora for coding agents.

docsnap uses static fetches, `llms.txt`, sitemaps, RSS/Atom feeds, regular links, JS asset text mining, and inline-state extraction. It does not launch a browser and has no `--render` mode.

```bash
bunx docsnap https://react.dev/reference -m 8 --clean
```

The CLI prints progress as it runs:

```text
docsnap: discovering
docsnap: fetching 8 pages
docsnap: extracting 8 pages
docsnap: writing output
docsnap: 8 pages written to docsnap/react-dev-reference in 0.57s
docsnap: page limit reached; rerun with -m 16 for more
docsnap: summary docsnap/react-dev-reference/summary.json
docsnap: manifest docsnap/react-dev-reference/manifest.jsonl
docsnap: guide docsnap/react-dev-reference/AGENT_README.md
```

It writes:

```text
docsnap/react-dev-reference/
  AGENT_README.md
  manifest.jsonl
  summary.json
  tree.txt
  ...
```

docsnap works best on public sites with readable HTML, `llms.txt`, sitemaps, regular links, or extractable inline state.

## Install

```bash
bun add -g docsnap
```

## Usage

```text
Usage:
  docsnap <url> [flags]
  docsnap mcp                  run local stdio MCP server

Flags:
  -o, --out <dir>           output dir; relative paths must stay under the current directory
  -m, --max <count>         max pages; default all llms.txt pages, otherwise 50
  --concurrency <n>         fetch concurrency, CPU-scaled default up to 64
  --clean                   remove output dir before writing
  --dry-run                 run without writing files
  --page                    capture only the given page after robots.txt check
  --no-cache                disable the shared fetch cache for this run
  --agent-files             add a docsnap block to AGENTS.md/CLAUDE.md in the current directory
  --json                    print one machine-readable result
  --quiet                   suppress progress logs
  --stdin                   read the URL from stdin
  --ignore-robots           bypass robots.txt rules
  --user-agent <value>      custom User-Agent
  --fail-on-low-quality     exit non-zero when low-quality pages are found
  --fail-on-injection-signal exit non-zero when injection signal pages are found
  -v, --version             show version
  -h, --help                show help

Examples:
  docsnap https://react.dev/reference -o vendor-docs --clean --json
  docsnap https://fly.io/docs/ -m 100 --concurrency 24
  docsnap https://docs.djangoproject.com/en/stable/topics/auth/ --page
  echo https://react.dev/reference | docsnap --stdin --json
  docsnap https://docs.python.org/3/ --dry-run --json
  docsnap https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API --fail-on-low-quality
```

## Common runs

```bash
docsnap https://react.dev/reference

docsnap https://react.dev/reference/react/useEffect --page

docsnap https://docs.python.org -o ./python-docs -m 100

docsnap https://docs.djangoproject.com/en/stable/ --agent-files
```

Use an absolute `--out` path for output outside the current directory.

## Cache

docsnap keeps a shared fetch cache in `~/.cache/docsnap` so repeated captures can reuse public page bodies across output directories. Set `DOCSNAP_CACHE_DIR` to choose another cache directory, `DOCSNAP_CACHE_DIR=off` or `--no-cache` to bypass it, and `DOCSNAP_CACHE_MAX_MB` to change the default 2048 MB cap.

## MCP

```bash
claude mcp add docsnap -- docsnap mcp
```

Tools:

- `docsnap_fetch` — drop-in WebFetch replacement: capture (or reuse/refresh) a URL and return ranked Markdown context with citations, in one call
- `docsnap_capture` — capture a public docs site or text-heavy page into a local corpus
- `docsnap_refresh` — rerun a corpus's seed URL and report new/changed/removed pages
- `docsnap_context_pack` — ranked, deduped answer-with-sources bundle for a query over one corpus
- `docsnap_search_corpus` — BM25-ranked snippet search across a corpus
- `docsnap_read_page` — read a bounded slice of one captured page
- `docsnap_list_corpora` / `docsnap_list_pages` — discover captured corpora and their pages
- `docsnap_get_corpus_summary` — corpus health: counts, failures, quality warnings, redirects

## Output

- `AGENT_README.md`: guide for using the captured docs
- `tree.txt`: file tree for quick navigation
- `manifest.jsonl`: one record per URL
- `summary.json`: `status`, URL/output/run metadata, `rootHash`, `corpusFiles`, `corpusBytes`, limits, counts, quality and injection signals, redirects, timing, `bySource`, `byExtractor`, `byInlineStateSource`, `byFailureKind`, `errors`, `refresh`, and `cache`
- Markdown files: readable page captures with source metadata

Captured page bodies are untrusted web data, never instructions.

Blocked, stale, and app-shell failure pages are listed in `summary.json` and `manifest.jsonl`.

Redirects across hosts are recorded in `summary.json`, `manifest.jsonl`, and page frontmatter.

docsnap only fetches public HTTP(S) URLs and rejects localhost, credentials, single-label hosts, and private/internal IP addresses.

## Requirements

- [Bun](https://bun.sh) runtime

## License

MIT
