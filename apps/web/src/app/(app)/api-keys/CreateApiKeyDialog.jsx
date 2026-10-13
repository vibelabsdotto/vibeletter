"use client";

import { useActionState, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { createApiKey } from "./actions";
import ButtonCopy from "@/components/ButtonCopy";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function CreateApiKeyDialog() {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState(false);
  function close() {
    if (pending) return;
    setOpen(false);
    setGeneration((value) => value + 1);
  }
  return (
    <Dialog open={open} onOpenChange={(value) => value ? setOpen(true) : close()}>
      <DialogTrigger asChild><Button><Plus data-icon="inline-start" />New</Button></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <CreateKeyForm key={generation} onClose={close} onPendingChange={setPending} />
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyForm({ onClose, onPendingChange }) {
  const [state, action, pending] = useActionState(async (previous, formData) => {
    onPendingChange(true);
    try { return await createApiKey(previous, formData); }
    finally { onPendingChange(false); }
  }, null);
  if (state?.key) return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Copy your key</DialogTitle>
        <DialogDescription>Shown only once. Store it in an environment variable or your password manager.</DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{state.key}</code>
        <ButtonCopy value={state.key} label="Copy key" />
      </div>
      <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
    </div>
  );
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <DialogHeader>
        <DialogTitle>New API key</DialogTitle>
        <DialogDescription>Grant only the access this integration needs.</DialogDescription>
      </DialogHeader>
      <Label htmlFor="api-key-name">Name</Label>
      <Input key={state?.name || "name"} id="api-key-name" name="name" required autoFocus maxLength={60}
        defaultValue={state?.name || ""} disabled={pending} />
      <Label htmlFor="api-key-scopes">Scopes, separated by commas</Label>
      <Input key={state?.scopes || "scopes"} id="api-key-scopes" name="scopes" required disabled={pending}
        defaultValue={state?.scopes ?? "contacts:read,contacts:write,campaigns:read,campaigns:write"}
        aria-describedby="api-key-scope-help" />
      <p id="api-key-scope-help" className="text-xs text-muted-foreground">
        Use resource:read or resource:write. Sending needs campaigns:send. Use * only for full operator access.
      </p>
      <Label htmlFor="api-key-expiry">Expires on, optional</Label>
      <Input key={state?.expiresAt || "expiry"} id="api-key-expiry" type="date" name="expiresAt" disabled={pending}
        defaultValue={state?.expiresAt || ""} aria-describedby="api-key-expiry-help" />
      <p id="api-key-expiry-help" className="text-xs text-muted-foreground">The key expires at the end of this date in UTC. Leave blank for no expiry.</p>
      {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}
