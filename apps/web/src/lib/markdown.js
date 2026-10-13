import { Marked, Tokenizer } from "marked";
import { calloutExtension } from "./callouts.js";

// marked is linear on real Markdown (500 KB in under 50 ms) but quadratic on a few shapes, like a long
// run of "*a" or of "> ". A parse running past this shows the Markdown as plain text instead. It's this
// high because the first parse on a cold server is many times slower, even for a short welcome email.
const MAX_PARSE_MS = 1000;

function escapeText(text) {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// The editor opens Markdown drafts in the browser too, so this module imports nothing server-only.
export function createMarkdownParser(...extensions) {
	let deadline = Infinity;
	// Every turn of marked's block and inline loops starts with one of these.
	const tokenizer = {};
	for (const name of ["space", "escape"]) {
		tokenizer[name] = function (src) {
			if (performance.now() > deadline) throw new Error("Markdown took too long to parse");
			return Tokenizer.prototype[name].call(this, src);
		};
	}
	const markdown = new Marked({ gfm: true, async: false }, ...extensions, { tokenizer });

	return (source) => {
		const text = source || "";
		deadline = performance.now() + MAX_PARSE_MS;
		try {
			return markdown.parse(text);
		} catch (error) {
			// Also when it nests deeper than marked's recursion can go.
			console.error("[markdown] Shown as plain text:", error.message.split("\n")[0]);
			return `<p>${escapeText(text)}</p>\n`;
		} finally {
			deadline = Infinity;
		}
	};
}

const parse = createMarkdownParser(calloutExtension());

export function markdownToHtml(source) {
	return parse(source);
}
