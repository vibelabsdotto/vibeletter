"use client";

import { useTransition } from "react";
import { MoreHorizontal, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import { setContactStatus } from "@/app/(app)/contacts/actions";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function MenuContact({ id, status }) {
	const [isPending, startTransition] = useTransition();
	if (!["active", "dormant"].includes(status)) return null;

	function update(nextStatus) {
		startTransition(async () => {
			const result = await setContactStatus(id, nextStatus);
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon-sm" aria-label="Actions" disabled={isPending}>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{status === "dormant" && (
					<DropdownMenuItem onSelect={() => update("active")}>
						<UserCheck />
						Reactivate
					</DropdownMenuItem>
				)}
				<DropdownMenuItem variant="destructive" onSelect={() => update("unsubscribed")}>
					<UserX />
					Unsubscribe
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
