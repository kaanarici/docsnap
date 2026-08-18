#!/usr/bin/env bun
import { runCli } from "./cli/index.ts";

await runCli(process.argv.slice(2));
