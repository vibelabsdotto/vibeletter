"use client";

import { useSubscribe } from "@/components/ProviderSubscribe";
import { Button } from "@/components/ui/button";

export default function ButtonSubscribe() {
	const { open } = useSubscribe();

	return (
		<Button size="sm" onClick={() => open()} className="h-8 px-3">
			Subscribe
		</Button>
	);
}
