import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIssueBody } from "../lib/archive-content.js";
import { cleanRichHtml } from "../lib/clean-html.js";

const rich = `<p style="color:#2D2D2D" class="lead">Hello <b>world</b> <a class="link" href="https://example.com?utm_source=x&amp;a=1" target="_blank" rel="noopener" style="color:blue">Example</a> <a href="javascript:alert(1)">bad</a></p>
<h2 id="chapter-1" style="font-size:24px">Chapter 1</h2>
<p><img style="width:100%" src="https://example.com/hero.jpg"></p>
<p><img alt="Game" src="https://example.com/game.jpg" style="width:100%"></p><small style="color:gray"><p><i>Caption</i></p></small>
<div data-callout="" style="background:red"><p>Boxed</p></div>`;

test("editor HTML keeps its content and drops inline themes and unsafe links", () => {
	const html = cleanRichHtml(rich);
	assert.ok(!/style=|class=/.test(html));
	assert.ok(html.includes("Hello <b>world</b>"));
	assert.ok(
		html.includes('<a href="https://example.com?utm_source=x&amp;a=1" target="_blank" rel="noopener">Example</a>')
	);
	assert.ok(html.includes("<a>bad</a>"), "javascript: links lose their href");
	assert.ok(html.includes('<h2 id="chapter-1">Chapter 1</h2>'));
	assert.ok(html.includes("<small><p><i>Caption</i></p></small>"));
	assert.ok(html.includes('<div data-callout=""><p>Boxed</p></div>'), "boxes keep only their marker");
});

test("the hero image loads first and the others lazily", () => {
	const { html } = renderIssueBody({ format: "rich", html: rich });
	assert.ok(html.includes('<img src="https://example.com/hero.jpg" fetchpriority="high" decoding="async" />'));
	assert.ok(html.includes('<img alt="Game" src="https://example.com/game.jpg" loading="lazy" decoding="async" />'));
});

test("issues pick the article layout unless their HTML has its own design", () => {
	const markdown = renderIssueBody({ format: "markdown", markdown: "## Hi\n\n![a](https://x.test/a.png)" });
	assert.equal(markdown.kind, "article");
	assert.ok(markdown.html.includes("<h2>Hi</h2>"));
	assert.ok(markdown.html.includes('fetchpriority="high"'));

	assert.equal(renderIssueBody({ format: "rich", html: rich }).kind, "article");

	const email = renderIssueBody({
		format: "html",
		html: '<html><head></head><body><table><tr><td><a href="{{unsubscribe_url}}">Bye</a></td></tr></table></body></html>',
	});
	assert.equal(email.kind, "frame");
	assert.ok(email.html.includes('<base target="_blank">'));
	assert.ok(email.html.includes('href="#"'));
	assert.ok(!/loading="lazy"/.test(email.html), "the frame measures its height once pictures load");
});

test("HTML sent through the API keeps its frame, even when it reads like an article", () => {
	const html = '<h2 id="chapter-1">Chapter 1</h2><p onclick="alert(1)">Hi <x_ onpointerover="alert(2)">there</x_></p>';
	assert.equal(renderIssueBody({ format: "html", html, source: "api" }).kind, "frame");

	const markdown = renderIssueBody({
		format: "markdown",
		markdown: '<p onclick="alert(1)">Hi <x_ onpointerover="alert(2)">there</x_></p>',
		source: "api",
	});
	assert.deepEqual(markdown, { kind: "article", html: "<p>Hi there</p>" });
});

test("inline issues go through the sanitizer when the page renders", () => {
	const { html } = renderIssueBody({ format: "rich", html: '<p><a href="//evil.test/x">x</a> <a href="/p/next">next</a></p>' });
	assert.equal(html, '<p><a>x</a> <a href="/p/next">next</a></p>', "links to other sites need their scheme");

	const body = renderIssueBody({ format: "rich", html: rich }).html;
	assert.ok(body.includes('<h2 id="chapter-1">Chapter 1</h2>'));
	assert.ok(body.includes('<div data-callout=""><p>Boxed</p></div>'));
});

test("Markdown tables, code and strikethrough keep their markup on the archive", () => {
	const { html } = renderIssueBody({
		format: "markdown",
		markdown: "#### Four\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```\ncode\n```\n\n~~old~~ `inline`",
	});
	assert.ok(html.includes("<h4>Four</h4>"));
	assert.ok(html.includes("<thead>\n<tr>\n<th>a</th>") && html.includes("<tbody><tr>\n<td>1</td>"));
	assert.ok(html.includes("<pre><code>code\n</code></pre>"));
	assert.ok(html.includes("<p><del>old</del> <code>inline</code></p>"));
});

test("scripts and unsafe links hidden from the cleaner don't reach the page", () => {
	const tricks = [
		"<scr<script></script>ipt>alert(1)</script>",
		"<script>alert(2)</script >",
		'<p>Hi</p><img src=x onerror="alert(3)"><a href=" javascript:alert(4)">x</a>',
		"<p>Bye</p><script src=//evil.test/x.js",
	].join("");
	for (const html of [cleanRichHtml(tricks), renderIssueBody({ format: "markdown", markdown: tricks }).html]) {
		assert.ok(!/<script|onerror|javascript:|<[^>]*\/\/evil/i.test(html), html);
		assert.ok(html.includes("Hi") && html.includes("Bye"));
	}
});

test("framed issues keep web, mail and image links only", () => {
	const { html } = renderIssueBody({
		format: "html",
		html: `<html><head></head><body><a href="https://x.test/a">Web</a><a href="mailto:a@x.test">Mail</a>
<a href="javascript:alert(1)">Bad</a><a title="t"href='&#106;avascript:alert(1)'>Encoded</a><a/href=vbscript:x>Slash</a>
<img src="data:image/png;base64,AAA"></body></html>`,
	});
	assert.ok(html.includes('href="https://x.test/a"') && html.includes('href="mailto:a@x.test"'));
	assert.ok(html.includes('src="data:image/png;base64,AAA"'));
	assert.ok(!/javascript|&#106;|vbscript/i.test(html), html);
});
