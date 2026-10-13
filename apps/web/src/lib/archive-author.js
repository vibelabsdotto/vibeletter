import { slugify } from "./slug.js";

// One person writes each newsletter: the From name, with the photo and bio set on the newsletter.
export function getArchiveAuthor(newsletter) {
	const name = newsletter.fromName || newsletter.name;
	return {
		name,
		slug: slugify(name, 60) || "author",
		bio: newsletter.author?.bio || "",
		imageUrl: newsletter.author?.imageUrl || newsletter.imageUrl || "",
	};
}
