"use client";

import { useActionState, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { createApiKey } from "@/app/(app)/api-keys/actions";
import ButtonCopy from "@/components/ButtonCopy";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export default function DialogCreateApiKey() {
	const [isOpen, setIsOpen] = useState(false);
	const [formKey, setFormKey] = useState(0);

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				setIsOpen(open);
				if (!open) setFormKey((key) => key + 1);
			}}
		>
			<DialogTrigger asChild>
				<Button>
					<Plus data-icon="inline-start" />
					New
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<FormApiKey key={formKey} />
			</DialogContent>
		</Dialog>
	);
}

function FormApiKey() {
	const [state, action, isPending] = useActionState(createApiKey, null);

	if (state?.key) {
		return (
			<>
				<DialogHeader>
					<DialogTitle>Copy your key</DialogTitle>
					<DialogDescription>It is shown once. Store it in your app env variables.</DialogDescription>
				</DialogHeader>
				<div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-3">
					<code className="min-w-0 flex-1 truncate font-mono text-[13px]">{state.key}</code>
					<ButtonCopy value={state.key} label="Copy key" />
				</div>
				<DialogFooter>
					<DialogClose asChild>
						<Button>Done</Button>
					</DialogClose>
				</DialogFooter>
			</>
		);
	}

	return (
		<form action={action} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>New API key</DialogTitle>
				<DialogDescription>Full access to contacts and campaigns.</DialogDescription>
			</DialogHeader>
			<Input name="name" placeholder="Name, e.g. Website signups" required autoFocus maxLength={60} />
			{state?.error && <p className="text-sm text-destructive">{state.error}</p>}
			<DialogFooter>
				<Button type="submit" disabled={isPending} className="min-w-20">
					{isPending ? <Loader2 className="animate-spin" /> : "Create"}
				</Button>
			</DialogFooter>
		</form>
	);
}
