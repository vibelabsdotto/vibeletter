"use client";

import { useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { createCampaign } from "@/app/(app)/campaigns/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function ButtonNewCampaign({ newsletters }) {
	const [isPending, startTransition] = useTransition();

	function create(newsletterId) {
		startTransition(async () => {
			const result = await createCampaign(newsletterId);
			if (result?.error) toast.error(result.error);
		});
	}

	const icon = isPending ? (
		<Loader2 data-icon="inline-start" className="animate-spin" />
	) : (
		<Plus data-icon="inline-start" />
	);

	if (newsletters.length === 0) {
		return (
			<Button asChild>
				<Link href="/newsletters/new">
					<Plus data-icon="inline-start" />
					New
				</Link>
			</Button>
		);
	}

	if (newsletters.length === 1) {
		return (
			<Button disabled={isPending} onClick={() => create(newsletters[0].id)}>
				{icon}
				New
			</Button>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button disabled={isPending}>
					{icon}
					New
					<ChevronDown data-icon="inline-end" className="opacity-60" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-52">
				{newsletters.map((newsletter) => (
					<DropdownMenuItem key={newsletter.id} onSelect={() => create(newsletter.id)} className="gap-2.5 py-1.5">
						<AvatarNewsletter newsletter={newsletter} size={24} />
						<span className="truncate">{newsletter.name}</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
