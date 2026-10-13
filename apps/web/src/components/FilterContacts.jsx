"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

const ALL = "all";

export default function FilterContacts({ newsletters }) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const [query, setQuery] = useState(searchParams.get("q") ?? "");
	const [isPending, startTransition] = useTransition();
	const timeout = useRef(null);

	function navigate(changes) {
		const params = new URLSearchParams(searchParams);
		for (const [key, value] of Object.entries(changes)) {
			if (value && value !== ALL) params.set(key, value);
			else params.delete(key);
		}
		params.delete("page");
		startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
	}

	function onQueryChange(event) {
		const value = event.target.value;
		setQuery(value);
		clearTimeout(timeout.current);
		timeout.current = setTimeout(() => navigate({ q: value.trim() }), 300);
	}

	useEffect(() => () => clearTimeout(timeout.current), []);

	return (
		<div className="flex flex-col gap-2 sm:flex-row">
			<div className="relative flex-1">
				{isPending ? (
					<Loader2 className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
				) : (
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
				)}
				<Input
					type="search"
					value={query}
					onChange={onQueryChange}
					placeholder="Search by email"
					aria-label="Search by email"
					className="h-9 pl-8"
				/>
			</div>
			<Select
				value={searchParams.get("newsletter") ?? ALL}
				onValueChange={(value) => navigate({ newsletter: value })}
			>
				<SelectTrigger className="h-9 w-full sm:w-52" aria-label="Newsletter">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ALL}>All newsletters</SelectItem>
					{newsletters.map((newsletter) => (
						<SelectItem key={newsletter.id} value={newsletter.id}>
							<span className="flex items-center gap-2">
								<AvatarNewsletter newsletter={newsletter} size={16} />
								{newsletter.name}
							</span>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
