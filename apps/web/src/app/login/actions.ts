"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getConfigProblems } from "@/lib/config";

export type LoginState = { error: string; email: string } | null;

function safeNextPath(value: FormDataEntryValue | null): string {
  return typeof value === "string" && /^\/(?!\/)[\w\-/]*$/.test(value) ? value : "/";
}

export async function login(_state: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = formData.get("password");
  if (getConfigProblems().length) return { error: "Login is unavailable until the server is configured.", email };
  if (typeof password !== "string" || !email || password.length > 128) {
    return { error: "Enter your email and password.", email };
  }
  try {
    await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
  } catch (error) {
    if (error instanceof APIError) {
      return { error: error.status === "TOO_MANY_REQUESTS" ? "Too many attempts. Try again in 15 minutes." : "Wrong email or password.", email };
    }
    return { error: "Login is unavailable. Try again later.", email };
  }
  redirect(safeNextPath(formData.get("next")));
}
