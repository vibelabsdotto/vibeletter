import ListIconLinks from "@/components/ListIconLinks";
import { getSocialPlatform } from "@/lib/social";

export default function LinksSocial({ links = [], className }) {
	const items = links
		.map((href) => ({ href, platform: getSocialPlatform(href) }))
		.filter(({ platform }) => platform)
		.map(({ href, platform }) => ({ href, platform, label: platform.label, rel: "me noopener" }));
	return <ListIconLinks items={items} className={className} />;
}
