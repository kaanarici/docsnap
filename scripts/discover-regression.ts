import { discoverNav } from "../src/discover/nav.ts";

const links = discoverNav(
	`<nav>
		<a class="nav-link" href="/general/downloads">Releases</a>
		<a class="nav-link dropdown-toggle" href="/Document" role="button" data-bs-toggle="dropdown" aria-expanded="false">Documentation</a>
		<ul><li><a class="dropdown-item" href="/docs/latest/">Latest</a></li></ul>
	</nav>`,
	"https://hive.apache.org/",
);

assert(links.includes("https://hive.apache.org/general/downloads"));
assert(links.includes("https://hive.apache.org/docs/latest/"));
assert(!links.includes("https://hive.apache.org/Document"));

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
