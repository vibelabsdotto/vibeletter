import Image from "next/image";
import { faviconUrl } from "@/lib/favicon";
import { cn } from "@/lib/utils";

export default function ImageFavicon({ domain, size = 16, className }) {
	if (!domain) return null;
	return (
		<Image
			src={faviconUrl(domain, size > 16 ? 64 : 32)}
			alt=""
			width={size}
			height={size}
			unoptimized
			loading="lazy"
			className={cn("shrink-0 rounded-[4px]", className)}
		/>
	);
}
