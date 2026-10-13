import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { authSchema } from "@/db/auth-schema";
import { getAppUrl, getOperatorEmail, isDevelopmentLoginAllowed } from "@/lib/config";
import { isRateLimited } from "@/lib/rate-limit";

// One operator means one guessing budget. Client-supplied proxy IPs cannot evade it.
async function limitLoginAttempts(): Promise<void> {
  if (await isRateLimited({ name: "operator-sign-in", key: "operator", limit: 10, window: "15 m" })) {
    throw new APIError("TOO_MANY_REQUESTS", { message: "Too many attempts. Try again in 15 minutes." });
  }
}

const localDevelopmentLogin = {
  id: "local-development-login",
  endpoints: {
    developmentLogin: createAuthEndpoint("/dev-login", { method: "POST" }, async (ctx) => {
      const request = ctx.request;
      if (!request || !isDevelopmentLoginAllowed(request.headers, request.url) ||
          request.headers.get("origin") !== new URL(getAppUrl()).origin) {
        throw new APIError("FORBIDDEN", { message: "Local development login is disabled." });
      }
      const email = getOperatorEmail();
      if (!email) throw new APIError("INTERNAL_SERVER_ERROR", { message: "ADMIN_EMAIL is not configured." });
      let operator = (await ctx.context.internalAdapter.findUserByEmail(email))?.user;
      if (!operator) {
        operator = await ctx.context.internalAdapter.createUser({
          email, name: "Local operator", emailVerified: true,
        }, { method: "local-development" });
      }
      const session = await ctx.context.internalAdapter.createSession(operator.id, false, { developmentOnly: true }, true);
      if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not create a session." });
      await setSessionCookie(ctx, { session, user: operator });
      ctx.setHeader("Cache-Control", "no-store");
      // Only Better Auth's HttpOnly cookie carries the session token.
      return ctx.json({ ok: true });
    }),
  },
};

export const auth = betterAuth({
  appName: "VibeLetter",
  baseURL: process.env.BETTER_AUTH_URL || getAppUrl(),
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
  trustedOrigins: [getAppUrl()],
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    requireEmailVerification: false,
  },
  user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
  account: { accountLinking: { enabled: false } },
  session: {
    expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false },
    additionalFields: { developmentOnly: { type: "boolean", defaultValue: false, required: false, input: false } },
  },
  advanced: { cookiePrefix: "vibeletter", useSecureCookies: process.env.NODE_ENV === "production" },
  disabledPaths: ["/sign-up/email"],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Independent credential login and logout must work with a stale dev cookie.
      // Read through Better Auth without refresh or re-entering the hook pipeline.
      if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-out" &&
          !isDevelopmentLoginAllowed(ctx.headers, ctx.request?.url)) {
        const current = await getSessionFromCtx(ctx, { disableCookieCache: true, disableRefresh: true });
        // The helper returns null on lookup failure. Do not let endpoint middleware
        // retry a supplied signed credential after a failed provenance check.
        const unresolved = !current && await ctx.getSignedCookie(
          ctx.context.authCookies.sessionToken.name, ctx.context.secret,
        );
        if (current?.session.developmentOnly || unresolved) {
          throw new APIError("UNAUTHORIZED", { message: "Session is not valid here. Sign in again." });
        }
      }
      if (ctx.path === "/sign-in/email") {
        await limitLoginAttempts();
        if (String(ctx.body?.email ?? "").trim().toLowerCase() !== getOperatorEmail()) {
          throw new APIError("UNAUTHORIZED", { message: "Invalid email or password." });
        }
      }
    }),
  },
  databaseHooks: {
    user: {
      create: { before: async (user) => user.email.toLowerCase() === getOperatorEmail() ? undefined : false },
      update: { before: async (user) => !user.email || user.email.toLowerCase() === getOperatorEmail() ? undefined : false },
    },
  },
  // Cookie propagation must be last for server actions.
  plugins: [localDevelopmentLogin, nextCookies()],
});

export type OperatorSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>> & {
  email: string;
};

// Preserve the old no-argument server-action API and the top-level email field.
export async function getSession(requestHeaders?: Headers): Promise<OperatorSession | null> {
  const currentHeaders = requestHeaders ?? await headers();
  let result;
  try {
    result = await auth.api.getSession({
      headers: currentHeaders,
      query: { disableCookieCache: true },
    });
  } catch (error) {
    if (error instanceof APIError && error.status === "UNAUTHORIZED") return null;
    throw error;
  }
  if (!result || result.user.email.toLowerCase() !== getOperatorEmail()) return null;
  if (result.session.developmentOnly && !isDevelopmentLoginAllowed(currentHeaders)) return null;
  return { ...result, email: result.user.email };
}

export async function requireSession(): Promise<OperatorSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function endSession(): Promise<void> {
  await auth.api.signOut({ headers: await headers() });
}
