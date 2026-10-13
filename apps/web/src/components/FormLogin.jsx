"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { login } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function FormLogin({ next, developmentLoginEnabled = false }) {
  const [state, action, isPending] = useActionState(login, null);
  const [developmentPending, setDevelopmentPending] = useState(false);
  const [developmentError, setDevelopmentError] = useState(null);
  const router = useRouter();
  const busy = isPending || developmentPending;

  async function developmentLogin() {
    if (busy) return;
    setDevelopmentPending(true);
    setDevelopmentError(null);
    try {
      const response = await fetch("/api/dev-login", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!response.ok) throw new Error("Local development login is unavailable.");
      router.replace(next || "/");
      router.refresh();
    } catch {
      setDevelopmentError("Local development login is unavailable.");
      setDevelopmentPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-3" aria-busy={busy}>
        <input type="hidden" name="next" value={next || "/"} />
        <Label htmlFor="login-email">Email</Label>
        <Input key={state?.email || "email"} id="login-email" name="email" type="email"
          defaultValue={state?.email || ""} autoComplete="email" required autoFocus
          disabled={busy} aria-invalid={Boolean(state?.error)} className="h-10" />
        <Label htmlFor="login-password">Password</Label>
        <Input id="login-password" name="password" type="password" autoComplete="current-password"
          required maxLength={128} disabled={busy} aria-invalid={Boolean(state?.error)} className="h-10" />
        {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        <Button type="submit" size="lg" disabled={busy} className="mt-1">
          {isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : "Continue"}
          {!isPending && <ArrowRight data-icon="inline-end" />}
        </Button>
      </form>
      {developmentLoginEnabled && (
        <div className="flex flex-col gap-2">
          <Button type="button" variant="outline" size="lg" disabled={busy} onClick={developmentLogin}>
            {developmentPending && <Loader2 aria-hidden="true" className="animate-spin" />}
            Local development login
          </Button>
          <p className="text-xs text-muted-foreground">Only enabled on this local development instance.</p>
          {developmentError && <p role="alert" className="text-sm text-destructive">{developmentError}</p>}
        </div>
      )}
    </div>
  );
}
