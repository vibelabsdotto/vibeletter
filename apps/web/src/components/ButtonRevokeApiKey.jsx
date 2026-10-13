"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { revokeApiKey } from "@/app/(app)/api-keys/actions";
import { Button } from "@/components/ui/button";

export default function ButtonRevokeApiKey({ id, name }) {
	const [isPending, startTransition] = useTransition();

	function revoke() {
		if (!window.confirm(`Revoke "${name}"? Apps using it stop working.`)) return;
		startTransition(async () => {
			const result = await revokeApiKey(id);
			if (result?.error) toast.error(result.error);
			else toast.success("Key revoked");
		});
	}

	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={revoke}
			disabled={isPending}
			className="text-muted-foreground hover:text-destructive"
		>
			{isPending ? <Loader2 className="animate-spin" /> : "Revoke"}
		</Button>
	);
}
