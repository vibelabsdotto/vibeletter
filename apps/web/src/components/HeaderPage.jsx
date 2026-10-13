import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export default function HeaderPage({ title, backHref, children, meta, icon }) {
	return (
		<header className="mb-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 animate-enter">
			<div className="flex min-w-0 items-center gap-2">
				{backHref && (
					<Link
						href={backHref}
						aria-label="Back"
						className="-ml-2 grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
					>
						<ChevronLeft className="size-5" />
					</Link>
				)}
				{icon}
				<h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
				{meta}
			</div>
			{children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
		</header>
	);
}
