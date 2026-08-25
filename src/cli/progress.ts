import { terminalText } from "../core/text.ts";

export function logLine(message: string): void {
	process.stderr.write(`${terminalText(message)}\n`);
}
