// An issue's public page path: /p/<slug>.
export const ARCHIVE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

export function slugify(value, maxLength = 40) {
	return String(value ?? "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength)
		.replace(/-+$/, "");
}

// Keeps what someone types in a slug field valid as they type; a pasted URL keeps its last segment.
export function toSlugInput(value) {
	const text = String(value ?? "");
	const segment = text.includes("/") ? (text.split("/").filter(Boolean).pop() ?? "") : text;
	return segment
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+/, "")
		.slice(0, 120);
}
