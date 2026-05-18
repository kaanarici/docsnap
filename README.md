# docsnap

Capture public docs as local Markdown that agents can search, cite, and read without browsing.

```bash
bunx docsnap https://react.dev/reference -m 8 --clean
```

The CLI shows each stage as it runs:

```text
docsnap: discovering
docsnap: fetching 8 pages
docsnap: extracting 8 pages
docsnap: writing output
docsnap: 8 pages written to docsnap/react-dev-reference in 0.57s
docsnap: page limit reached; rerun with -m 16 for more
docsnap: summary docsnap/react-dev-reference/summary.json
docsnap: manifest docsnap/react-dev-reference/manifest.jsonl
docsnap: agent handoff docsnap/react-dev-reference/AGENT_README.md
```

It writes a small folder:

```text
docsnap/react-dev-reference/
  AGENT_README.md
  manifest.jsonl
  summary.json
  tree.txt
  ...
```

Use it when an agent needs current docs from a site, a framework, or one exact page. It works best on docs with readable HTML, `llms.txt`, sitemaps, or normal navigation links.

## Install

```bash
bun add -g docsnap
```

## Usage

```text
docsnap <url> [options]

Options:
  -o, --out <dir>           output directory, default docsnap/<site>
  -m, --max <count>         max pages; default all llms.txt pages, otherwise 50
  --concurrency <n>         fetch concurrency, default 64
  --clean                   remove output dir before writing
  --dry-run                 run without writing files
  --page                    capture only the given page
  --agent-files             update existing AGENTS.md/CLAUDE.md files
  --json                    print one machine-readable result
  --quiet                   suppress progress logs
  --stdin                   read the URL from stdin
  --fail-on-low-quality     exit non-zero when low-quality pages are found
```

## Common runs

```bash
docsnap https://react.dev/reference

docsnap https://react.dev/reference/react/useEffect --page

docsnap https://docs.python.org -o ./python-docs -m 100

docsnap https://docs.djangoproject.com/en/stable/ --agent-files
```

## Output

- `AGENT_README.md`: handoff for the captured docs
- `tree.txt`: file tree for quick navigation
- `manifest.jsonl`: one record per URL
- `summary.json`: counts, failures, hashes, and timing
- Markdown files: readable page captures with source metadata

docsnap reports blocked, stale, or client-rendered pages instead of hiding them.

## Requirements

- [Bun](https://bun.sh) runtime

## License

MIT
