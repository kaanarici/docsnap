# docsnap

Pull public docs into local Markdown files for coding agents.

```bash
bunx docsnap https://example.com/docs
```

docsnap writes Markdown plus an agent handoff:

```text
docsnap/example-com/
  AGENT_README.md
  manifest.jsonl
  summary.json
  tree.txt
  ...
```

## Install

```bash
bun add -g docsnap
```

## Usage

```text
docsnap <url> [options]

Options:
  -o, --out <dir>         output directory, default docsnap/<site>
  -m, --max <count>      max pages
  --page                 capture only the given page
  --clean                remove the output directory before writing
  --json                 print one machine-readable result
  --agent-files          link the handoff from AGENTS.md and CLAUDE.md
```

## Examples

```bash
# Pull docs for an agent
docsnap https://react.dev/reference

# Capture one page
docsnap https://example.com/docs/page --page

# Custom output dir, limit to 100 pages
docsnap https://docs.python.org -o ./python-docs -m 100
```

## How it works

1. Finds pages from `llms.txt`, sitemaps, navigation links, and bounded crawling.
2. Fetches public HTTP(S) pages with private-network protections.
3. Converts readable pages to Markdown with source metadata.
4. Writes an agent-friendly folder with `AGENT_README.md`, `tree.txt`, `manifest.jsonl`, and `summary.json`.

If a page is blocked, stale, or client-rendered with no readable HTML, docsnap reports that instead of pretending the capture is complete.

## Requirements

- [Bun](https://bun.sh) runtime

## License

MIT
