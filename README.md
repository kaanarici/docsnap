# docsnap

Pull public docs and text-heavy pages into a local Markdown folder for coding agents.

```bash
bunx docsnap https://example.com/docs
```

docsnap checks `llms.txt`, sitemaps, navigation links, and a bounded crawl fallback. It writes Markdown plus `AGENT_README.md`, `tree.txt`, `manifest.jsonl`, and `summary.json`.

It works best on public docs and server-rendered text pages. If a page is thin, blocked, or client-rendered with no readable HTML, docsnap reports that instead of pretending the capture is complete.

## Install

```bash
bun add -g docsnap
```

## Use

```bash
docsnap <url>
docsnap <url> -o <dir> -m <count>
echo https://example.com/docs | docsnap --stdin --json
```

Output defaults to `docsnap/<site>`. Point your agent at `AGENT_README.md` inside that directory, or pass `--agent-files` to link it from existing `AGENTS.md` and `CLAUDE.md` files.

```bash
-o, --out <dir>         output directory, default docsnap/<site>
-m, --max <count>      max pages; default all llms.txt pages, otherwise 50
--concurrency <n>      fetch concurrency, CPU-scaled default
--clean                remove the output directory before writing
--dry-run              discover and extract without writing files
--agent-files          update existing AGENTS.md/CLAUDE.md files
--json                 print one machine-readable result
--quiet                suppress progress logs
--stdin                read the URL from stdin
--ignore-robots        bypass robots.txt rules
--user-agent <value>   custom User-Agent
--fail-on-low-quality  exit non-zero when low-quality pages are found
-h, --help             show help
-v, --version          show version
```

## Development

```bash
bun install
bun run check
```
