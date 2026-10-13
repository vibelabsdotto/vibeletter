"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { OperatorError } from "@/lib/operator-api";
import { createApiKey as saveApiKey, revokeApiKey as revokeStoredKey } from "@/server/operator-security";

export type CreateKeyState = {
  key?: string;
  error?: string;
  name?: string;
  scopes?: string;
  expiresAt?: string;
} | null;

export async function createApiKey(_state: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const scopes = String(formData.get("scopes") ?? "contacts:read,contacts:write,campaigns:read,campaigns:write").trim();
  const expiresAt = String(formData.get("expiresAt") ?? "").trim();
  try {
    const saved = await saveApiKey({
      name, scopes: scopes.split(",").map((scope) => scope.trim()),
      expiresAt: expiresAt ? `${expiresAt}T23:59:59.999Z` : null,
    }, { ...session, kind: "session", scopes: ["*"] });
    revalidatePath("/api-keys");
    return { key: saved.key };
  } catch (error) {
    return { error: error instanceof OperatorError ? error.message : "Could not create the API key.", name, scopes, expiresAt };
  }
}

export async function revokeApiKey(id: string): Promise<{ ok?: true; error?: string }> {
  await requireSession();
  try {
    await revokeStoredKey(id);
    revalidatePath("/api-keys");
    return { ok: true };
  } catch (error) {
    return { error: error instanceof OperatorError ? error.message : "Could not revoke the API key." };
  }
}
