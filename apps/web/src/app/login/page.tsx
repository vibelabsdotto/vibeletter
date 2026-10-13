import { headers } from "next/headers";
import { redirect } from "next/navigation";
import FormLogin from "@/components/FormLogin";
import LogoMailcheap from "@/components/LogoMailcheap";
import { getSession } from "@/lib/auth";
import { isDevelopmentLoginAllowed } from "@/lib/config";

export const metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getSession()) redirect("/");
  const { next } = await searchParams;
  const nextPath = typeof next === "string" && /^\/(?!\/)[\w\-/]*$/.test(next) ? next : "/";
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-xs">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <LogoMailcheap className="size-10" />
          <h1 className="text-lg font-semibold tracking-tight">Log in to VibeLetter</h1>
        </div>
        <FormLogin next={nextPath} developmentLoginEnabled={isDevelopmentLoginAllowed(await headers())} />
      </div>
    </main>
  );
}
