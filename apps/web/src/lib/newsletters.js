export const NEWSLETTER_SUMMARY_FIELDS = "name slug imageUrl fromEmail";
export const MAX_DESCRIPTION_LENGTH = 200;
export const MAX_AUTHOR_BIO_LENGTH = 160;

export function toNewsletterOptions(newsletters) {
	return newsletters.map(({ _id, name, imageUrl, fromEmail }) => ({
		id: _id.toString(),
		name,
		imageUrl: imageUrl || null,
		fromEmail: fromEmail || null,
	}));
}

export function toNewsletterMap(newsletters) {
	return Object.fromEntries(toNewsletterOptions(newsletters).map((option) => [option.id, option]));
}
