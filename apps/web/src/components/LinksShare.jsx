import ListIconLinks from "@/components/ListIconLinks";
import { getShareLinks } from "@/lib/social";

export default function LinksShare({ url, text, className }) {
	const items = getShareLinks({ url, text }).map(({ href, label, path }) => ({
		href,
		label,
		rel: "noopener",
		platform: { path },
	}));
	return <ListIconLinks items={items} className={className} />;
}
