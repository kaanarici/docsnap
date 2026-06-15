// linear two-pointer glob matcher ('*' = any run, '?' = one char). Built without
// a RegExp because path_glob is MCP-caller-supplied: turning many '*' into '.*'
// causes catastrophic backtracking (ReDoS) that hangs the server event loop.
export function globMatches(pattern: string, path: string): boolean {
	let p = 0;
	let t = 0;
	let star = -1;
	let mark = 0;
	while (t < path.length) {
		if (p < pattern.length && (pattern[p] === path[t] || pattern[p] === "?")) {
			p++;
			t++;
		} else if (p < pattern.length && pattern[p] === "*") {
			star = p++;
			mark = t;
		} else if (star >= 0) {
			p = star + 1;
			t = ++mark;
		} else {
			return false;
		}
	}
	while (p < pattern.length && pattern[p] === "*") p++;
	return p === pattern.length;
}
