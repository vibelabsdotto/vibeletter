import { Node } from "@tiptap/core";

// A gray box around any blocks. It renders the archive's markup, so the editor shows it exactly as
// readers will.
export const Callout = Node.create({
	name: "callout",
	group: "block",
	content: "block+",
	defining: true,
	parseHTML() {
		return [{ tag: "div[data-callout]" }];
	},
	renderHTML() {
		return ["div", { "data-callout": "" }, 0];
	},
});
