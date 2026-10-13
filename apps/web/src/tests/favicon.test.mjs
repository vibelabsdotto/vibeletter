import assert from "node:assert/strict";
import { test } from "node:test";
import { faviconUrl, rootDomain } from "../lib/favicon.js";

test("root domains come from hosts and email addresses", () => {
	assert.equal(rootDomain("mail.example.com"), "example.com");
	assert.equal(rootDomain("news.example.org"), "example.org");
	assert.equal(rootDomain("Reader@Mail.Example.co.uk"), "example.co.uk");
	assert.equal(rootDomain("jane@example.com"), "example.com");
	assert.equal(rootDomain(""), "");
});

test("favicon URLs are encoded and sized", () => {
	assert.equal(faviconUrl("example.com", 32), "https://www.google.com/s2/favicons?domain=example.com&sz=32");
	assert.ok(faviconUrl("a b").includes("domain=a%20b"));
});
