import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIssueBody } from "../lib/archive-content.js";
import { cleanRichHtml } from "../lib/clean-html.js";
import { renderEmail } from "../lib/render-email.js";

test("editor boxes keep only their marker, other divs become plain layout", () => {
	const html = cleanRichHtml(`<div data-callout="" style="background:#fff8e6"><p>Update</p></div>
<div style="background-color:#fcf5ff;padding:0"><p>Tint</p></div>`);
	assert.ok(html.includes('<div data-callout=""><p>Update</p></div>'));
	assert.ok(html.includes("<div><p>Tint</p></div>"));
	assert.ok(!html.includes("#fff8e6"));
});

test("highlights lose their inline colors", () => {
	const html = cleanRichHtml('<p><mark style="background-color:#fff4d1">Margin.</mark></p>');
	assert.ok(html.includes("<mark>Margin.</mark>"));
});

const markdown = "Intro\n\n:::box\n**Project update**\n\n- Shipped the editor\n:::\n\n:::box\nSponsor\n:::\n\nOutro";

test("Markdown boxes become archive boxes", () => {
	const { html } = renderIssueBody({ format: "markdown", markdown });
	assert.ok(
		html.includes('<div data-callout=""><p><strong>Project update</strong></p>\n<ul>\n<li>Shipped the editor</li>\n</ul>\n</div>')
	);
	assert.ok(html.includes('<div data-callout=""><p>Sponsor</p>'));
	assert.ok(html.includes("<p>Outro</p>"));
});

test("Markdown boxes are gray inline-styled boxes in emails", () => {
	const { html, text } = renderEmail({ format: "markdown", markdown, newsletter: { name: "Field notes" } });
	assert.equal(html.split("border-radius:12px;background:#f4f4f5;").length - 1, 2);
	assert.ok(!html.includes(":::"));
	assert.match(text, /Shipped the editor/);
});
