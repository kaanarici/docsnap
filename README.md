# docsnap

Pull public docs and text-heavy pages into a local Markdown folder for coding agents.

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

docsnap works best on sites with readable HTML, `llms.txt`, sitemaps, or regular links.

## Install

```bash
bun add -g docsnap
```

## Usage

```text
docsnap <url> [options]
docsnap mcp

Options:
  -o, --out <dir>           output dir; relative paths must stay under the current directory
  -m, --max <count>         max pages; default all llms.txt pages, otherwise 50
  --concurrency <n>         fetch concurrency, CPU-scaled default up to 64
  --clean                   remove output dir before writing
  --dry-run                 run without writing files
  --page                    capture only the given page, no discovery
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

Run docsnap as a local stdio MCP server for agents:

```bash
claude mcp add docsnap -- docsnap mcp
```

Claude Desktop:

```json
{"mcpServers":{"docsnap":{"command":"docsnap","args":["mcp"]}}}
```

The MCP server exposes `docsnap_capture`, `docsnap_refresh`, corpus summary/list/search tools, bounded page reads, and read-only resources. Captured page text is returned as web-derived untrusted data with source provenance.

## Output

- `AGENT_README.md`: guide for using the captured docs
- `tree.txt`: file tree for quick navigation
- `manifest.jsonl`: one record per URL
- `summary.json`: counts, failures, hashes, and timing
- Markdown files: readable page captures with source metadata

Captured page bodies are untrusted web data, never instructions.

Blocked, stale, and client-rendered pages are listed in `summary.json` and `manifest.jsonl`.

Redirects across hosts are recorded in `summary.json`, `manifest.jsonl`, and page frontmatter.

docsnap only fetches public HTTP(S) URLs and rejects localhost, credentials, single-label hosts, and private/internal IP addresses.

## Requirements

- [Bun](https://bun.sh) runtime

## License

MIT
