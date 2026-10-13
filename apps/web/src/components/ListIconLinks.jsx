import ImageFavicon from "@/components/ImageFavicon";
import { cn } from "@/lib/utils";

export default function ListIconLinks({ items, className }) {
	if (items.length === 0) return null;
	return (
		<ul className={cn("flex flex-wrap items-center gap-0.5", className)}>
			{items.map(({ href, label, rel, platform }) => (
				<li key={href}>
					<a
						href={href}
						target="_blank"
						rel={rel}
						aria-label={label}
						title={label}
						className="grid size-9 place-items-center rounded-full text-muted-foreground transition-[color,background-color] duration-150 hover:bg-muted hover:text-foreground"
					>
						{platform.path ? (
							<svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-current">
								<path d={platform.path} />
							</svg>
						) : (
							<ImageFavicon domain={platform.domain} size={16} />
						)}
					</a>
				</li>
			))}
		</ul>
	);
}
