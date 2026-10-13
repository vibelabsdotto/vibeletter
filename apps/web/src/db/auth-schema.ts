import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Better Auth's model names stay singular; physical names cannot collide with app tables.
export const user = sqliteTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable("auth_session", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  developmentOnly: integer("development_only", { mode: "boolean" }).notNull().default(false),
}, (table) => [index("auth_session_user_idx").on(table.userId)]);

export const account = sqliteTable("auth_account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("auth_account_user_idx").on(table.userId),
  uniqueIndex("auth_account_provider_idx").on(table.providerId, table.accountId),
]);

export const verification = sqliteTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("auth_verification_identifier_idx").on(table.identifier)]);

export const authSchema = { user, session, account, verification };
