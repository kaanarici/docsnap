import { srcsetCandidates } from "../discover/nav.ts";
import { appShellDom } from "../extract/app-shell.ts";

const maxRenderedDomNodes = 100_000;

export const blockerSource = `(() => {
	const blocked = name => class { constructor() { throw new DOMException(name + " disabled", "SecurityError"); } };
	for (const name of ["WebSocket", "EventSource", "WebTransport", "SharedWorker", "RTCPeerConnection", "webkitRTCPeerConnection"]) Object.defineProperty(globalThis, name, { value: blocked(name), configurable: false, writable: false });
	if (globalThis.navigator && "sendBeacon" in navigator) Object.defineProperty(navigator, "sendBeacon", { value: () => false, configurable: false, writable: false });
	try { if (globalThis.Navigator) delete Navigator.prototype.serviceWorker; } catch {}
})();`;

export const shellStateExpression = `(() => {
	const roots = [document];
	let pendingFrames = 0, embeddedFingerprint = "";
	for (let index = 0; index < roots.length; index++) for (const element of roots[index].querySelectorAll("*")) {
		if (element.shadowRoot) roots.push(element.shadowRoot);
		try { if (element.tagName === "IFRAME") {
			const frame = element.contentDocument, src = element.getAttribute("src");
			if (src && new URL(src, element.baseURI).origin === location.origin) {
				if (!frame || frame.readyState === "loading" || frame.URL === "about:blank" && !frame.body?.childElementCount) pendingFrames++;
				else embeddedFingerprint += frame.URL + ":" + (frame.body?.textContent ?? "").length;
			}
			if (frame) roots.push(frame);
		} } catch {}
	}
	const primary = roots.map(root => root.querySelector(${JSON.stringify(appShellDom.mount)}) ?? root.querySelector(${JSON.stringify(appShellDom.primary)}) ?? root.body ?? root.host).filter(Boolean).sort((a, b) => (b.textContent ?? "").length - (a.textContent ?? "").length)[0];
	const text = (typeof primary?.innerText === "string" ? primary.innerText : primary?.textContent ?? "").replace(/\\s+/g, " ").trim();
	const meaningful = (primary?.matches(${JSON.stringify(appShellDom.meaningful)}) && text ? 1 : 0) + Array.from(primary?.querySelectorAll(${JSON.stringify(appShellDom.meaningful)}) ?? []).filter(node => (node.textContent ?? "").trim()).length;
	const loadingHits = text.slice(0, 180).match(new RegExp(${JSON.stringify(appShellDom.loading)}, "gi"))?.length ?? 0;
	let fingerprint = 2166136261;
	for (const char of text + embeddedFingerprint + Array.from(primary?.querySelectorAll("a[href],img[src],source[src],source[srcset],video[src],audio[src]") ?? [], node => [node.tagName, node.getAttribute("href"), node.getAttribute("src"), node.getAttribute("srcset")].join(":")).join("|")) fingerprint = Math.imul(fingerprint ^ char.charCodeAt(0), 16777619);
	return [document.readyState !== "loading", text.length, meaningful, loadingHits > 0 && (text.length < 180 || loadingHits > 1), fingerprint >>> 0, pendingFrames];
})()`;

export const renderedPageExpression = (maxBytes: number) => `(() => {
	const parseSrcset = ${srcsetCandidates.toString()};
	const primarySelector = ${JSON.stringify(`${appShellDom.mount},${appShellDom.primary}`)};
	const roots = [document.documentElement];
	const nodeLimit = Math.min(${maxRenderedDomNodes}, Math.max(1000, Math.floor(${maxBytes} / 64)));
	let nodes = 0, estimatedBytes = 0;
	const exceeded = reason => ["", location.href, ${maxBytes + 1}, reason];
	const absoluteUrl = (value, base) => { try { return new URL(value, base).href; } catch { return value; } };
	const rewrittenAttribute = (name, value, base) => name === "srcset"
		? parseSrcset(value).map(candidate => [absoluteUrl(candidate.url, base), candidate.descriptor].filter(Boolean).join(" ")).join(", ")
		: name === "href" || name === "src" || name === "poster" ? absoluteUrl(value, base) : value;
	const add = (value, overhead = 0, quoted = false) => {
		estimatedBytes += overhead;
		for (let index = 0; index < value.length && estimatedBytes <= ${maxBytes}; index++) {
			const code = value.charCodeAt(index);
			if (code < 0x80) estimatedBytes++;
			else if (code < 0x800) estimatedBytes += 2;
			else if (code >= 0xD800 && code <= 0xDBFF && value.charCodeAt(index + 1) >= 0xDC00 && value.charCodeAt(index + 1) <= 0xDFFF) { estimatedBytes += 4; index++; }
			else estimatedBytes += 3;
			if (value[index] === "&") estimatedBytes += 4;
			else if (value[index] === "<" || value[index] === ">") estimatedBytes += 3;
			else if (quoted && value[index] === '"') estimatedBytes += 5;
		}
		return estimatedBytes <= ${maxBytes};
	};
	for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
		const root = roots[rootIndex];
		if (!root) continue;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
		for (let node = root; node; node = walker.nextNode()) {
			if (++nodes > nodeLimit) return exceeded("DOM node budget");
			if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) {
				if (!add(node.nodeValue ?? "", node.nodeType === Node.COMMENT_NODE ? 7 : 0)) return exceeded("DOM byte budget");
				continue;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) continue;
			if (!add(node.tagName, 5) || !add(node.tagName, 3)) return exceeded("DOM byte budget");
			for (const attribute of node.attributes) {
				if (!add(attribute.name, 4)) return exceeded("DOM byte budget");
				if (!add(rewrittenAttribute(attribute.name, attribute.value, node.baseURI), 0, true)) return exceeded("DOM byte budget");
			}
			if (node.shadowRoot) {
				roots.push(node.shadowRoot);
				if (!add("shadow", 48, true)) return exceeded("DOM byte budget");
			}
			if (node.tagName === "TEMPLATE") roots.push(node.content);
			try { if (node.tagName === "IFRAME" && node.contentDocument?.documentElement) {
				roots.push(node.contentDocument.documentElement);
				if (!add(absoluteUrl(node.getAttribute("src") ?? "", node.baseURI), 96, true)) return exceeded("DOM byte budget");
			} } catch {}
		}
	}
	const copyRoots = (sourceRoot, targetRoot) => {
		const sources = Array.from(sourceRoot.querySelectorAll("*"));
		const targets = Array.from(targetRoot.querySelectorAll("*")).slice(0, sources.length);
		for (let index = 0; index < sources.length; index++) {
			const source = sources[index], target = targets[index];
			if (!target) continue;
			for (const name of ["href", "src", "poster", "srcset"]) if (source.hasAttribute(name)) target.setAttribute(name, rewrittenAttribute(name, source.getAttribute(name), source.baseURI));
			let embedded = source.shadowRoot, kind = "shadow";
			try { if (!embedded && source.tagName === "IFRAME") { embedded = source.contentDocument?.body; kind = "frame"; } } catch {}
			if (!embedded) continue;
			const section = document.createElement("section");
			section.setAttribute("data-docsnap-root", kind);
			section.append(...Array.from(embedded.childNodes, node => node.cloneNode(true)));
			copyRoots(embedded, section);
			if (kind === "frame") {
				const link = document.createElement("a");
				link.href = source.src; link.textContent = "Embedded frame";
				section.prepend(link);
				const primary = target.closest(primarySelector) ?? targetRoot.querySelector(primarySelector);
				if (primary && !primary.contains(target)) { target.remove(); primary.append(section); }
				else target.replaceWith(section);
			} else target.append(section);
		}
	};
	const root = document.documentElement?.cloneNode(true);
	if (!root) return ["", location.href, 0];
	copyRoots(document.documentElement, root);
	const html = root.outerHTML, bytes = new TextEncoder().encode(html).byteLength;
	return [bytes <= ${maxBytes} ? html : "", location.href, bytes, ""];
})()`;
