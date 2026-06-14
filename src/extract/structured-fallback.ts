import { wordCount } from "../core/text.ts";
import { serializeRoot } from "./structured-fallback-render.ts";
import {
	countTextChars,
	emptyStats,
	isCandidateRoot,
	isElement,
	isPreferredRoot,
	linkDensity,
	maxRootFrames,
	shouldSkipElement,
	type TextStats,
	tagName,
	textNode,
} from "./structured-fallback-shared.ts";

type Candidate = TextStats & {
	element: Element;
	score: number;
};

type RootScan = {
	best?: Candidate;
	preferred?: Candidate;
	stats: WeakMap<Node, TextStats>;
};

export function structuredFallback(
	document: Document,
	baseUrl: string,
): string {
	const root = document.body ?? document.documentElement;
	if (!root) return "";

	const scan = scanRoot(root);
	const chosen = chooseRoot(root, scan);
	const stats = scan.stats.get(chosen) ?? emptyStats();
	if (stats.textChars < 40 || linkDensity(stats) >= 0.5) return "";

	const markdown = serializeRoot(chosen, baseUrl).trim();
	return wordCount(markdown) >= 3 ? markdown : "";
}

function scanRoot(root: Element): RootScan {
	const stats = new WeakMap<Node, TextStats>();
	const stack: Array<{
		node: Node;
		inAnchor: boolean;
		exit: boolean;
	}> = [{ node: root, inAnchor: false, exit: false }];
	let frames = 1;
	let best: Candidate | undefined;
	let preferred: Candidate | undefined;

	while (stack.length > 0 && frames <= maxRootFrames) {
		const frame = stack.pop()!;
		const node = frame.node;
		if (node.nodeType === textNode) {
			const textChars = countTextChars(node.textContent ?? "");
			stats.set(node, {
				textChars,
				anchorChars: frame.inAnchor ? textChars : 0,
			});
			continue;
		}
		if (!isElement(node)) continue;
		if (frame.exit) {
			const total = sumChildStats(node, stats);
			stats.set(node, total);
			const candidate = candidateFor(node, total);
			if (candidate) {
				if (isPreferredRoot(node)) {
					if (!preferred || candidate.score > preferred.score)
						preferred = candidate;
				} else if (!best || candidate.score > best.score) {
					best = candidate;
				}
			}
			continue;
		}
		if (node !== root && shouldSkipElement(node)) {
			stats.set(node, emptyStats());
			continue;
		}
		stack.push({ node, inAnchor: frame.inAnchor, exit: true });
		frames++;
		const children = node.childNodes;
		const childInAnchor = frame.inAnchor || tagName(node) === "a";
		for (let index = children.length - 1; index >= 0; index--) {
			if (frames >= maxRootFrames) break;
			const child = children[index];
			if (!child) continue;
			stack.push({ node: child, inAnchor: childInAnchor, exit: false });
			frames++;
		}
	}

	return {
		...(best ? { best } : {}),
		...(preferred ? { preferred } : {}),
		stats,
	};
}

function chooseRoot(root: Element, scan: RootScan): Element {
	return scan.preferred?.element ?? scan.best?.element ?? root;
}

function candidateFor(
	element: Element,
	stats: TextStats,
): Candidate | undefined {
	if (stats.textChars < 80 || linkDensity(stats) > 0.5) return undefined;
	if (!isCandidateRoot(element) && !isPreferredRoot(element)) return undefined;
	const score = stats.textChars * (1 - linkDensity(stats));
	return { element, score, ...stats };
}

function sumChildStats(
	element: Element,
	stats: WeakMap<Node, TextStats>,
): TextStats {
	const total = emptyStats();
	for (let index = 0; index < element.childNodes.length; index++) {
		const child = element.childNodes[index];
		if (!child) continue;
		const childStats = stats.get(child);
		if (!childStats) continue;
		total.textChars += childStats.textChars;
		total.anchorChars += childStats.anchorChars;
	}
	return total;
}
