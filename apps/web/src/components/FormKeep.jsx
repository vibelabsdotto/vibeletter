"use client";

import { useActionState } from "react";
import { HeartHandshake, Link2Off, Loader2, MailCheck } from "lucide-react";
import { keepSending } from "@/app/keep/actions";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";

// Link scanners open the page without submitting forms, so only a person's browser says yes.
export default function FormKeep({ token, newsletterName, archiveUrl }) {
	const [state, action, isPending] = useActionState(keepSending.bind(null, token), null);

	if (state?.ok) {
		return (
			<CardNotice icon={MailCheck} tone="success" title={`You'll keep getting ${newsletterName}`}>
				Thanks for letting me know. The next issue lands in your inbox.
				{archiveUrl && (
					<Button asChild size="lg" variant="outline" className="mt-6 w-full">
						<a href={archiveUrl}>Read past issues</a>
					</Button>
				)}
			</CardNotice>
		);
	}

	if (state?.error === "invalid") {
		return (
			<CardNotice icon={Link2Off} title="This link doesn't work">
				It may be older than 90 days, or you unsubscribed. Sign up again to get {newsletterName}.
				{archiveUrl && (
					<Button asChild size="lg" variant="outline" className="mt-6 w-full">
						<a href={archiveUrl}>Sign up again</a>
					</Button>
				)}
			</CardNotice>
		);
	}

	return (
		<CardNotice
			icon={isPending ? Loader2 : HeartHandshake}
			spin={isPending}
			title={`Keep getting ${newsletterName}?`}
		>
			{state?.error === "busy"
				? "Too many clicks from your network. Try again in a few minutes."
				: "One click and it keeps coming."}
			<form action={action} className="mt-6">
				<Button type="submit" size="lg" disabled={isPending} className="w-full">
					{isPending ? "Saving…" : "Yes, keep sending it"}
				</Button>
			</form>
		</CardNotice>
	);
}
