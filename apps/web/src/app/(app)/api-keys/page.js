import { KeyRound } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonCopy from "@/components/ButtonCopy";
import ButtonRevokeApiKey from "@/components/ButtonRevokeApiKey";
import DialogCreateApiKey from "./CreateApiKeyDialog";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { getAppUrl } from "@/lib/config";
import { desc } from "drizzle-orm";
import { db, connectDb } from "@/db";
import { apiKeys as apiKeyTable } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { formatDate, formatRelative } from "@/lib/format";

export const metadata = { title: "API keys" };

export default async function ApiKeysPage() {
	await requireSession();
	await connectDb();
	const apiKeys = db.select({
		_id: apiKeyTable._id, name: apiKeyTable.name, prefix: apiKeyTable.prefix,
		scopes: apiKeyTable.scopes, expiresAt: apiKeyTable.expiresAt,
		createdAt: apiKeyTable.createdAt, lastUsedAt: apiKeyTable.lastUsedAt, revokedAt: apiKeyTable.revokedAt,
	}).from(apiKeyTable).orderBy(desc(apiKeyTable.createdAt)).all();
	const examples = getExamples(getAppUrl());

	return (
		<>
			<HeaderPage title="API keys">
				<DialogCreateApiKey />
			</HeaderPage>

			<div className="flex flex-col gap-8">
				{apiKeys.length === 0 ? (
					<StateEmpty icon={KeyRound} title="No API keys yet" />
				) : (
					<div className="overflow-hidden rounded-xl shadow-border animate-enter">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">Name</TableHead>
									<TableHead>Key</TableHead>
									<TableHead className="hidden md:table-cell">Scopes / expiry</TableHead>
									<TableHead className="hidden sm:table-cell">Created</TableHead>
									<TableHead className="hidden sm:table-cell">Last used</TableHead>
									<TableHead className="w-24 pr-2" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{apiKeys.map((apiKey) => (
									<TableRow key={apiKey._id.toString()}>
										<TableCell className="py-2.5 pl-4 font-medium">{apiKey.name}</TableCell>
										<TableCell className="font-mono text-xs text-muted-foreground">{apiKey.prefix}</TableCell>
										<TableCell className="hidden max-w-xs whitespace-normal text-xs text-muted-foreground md:table-cell">
											{apiKey.scopes.join(", ")}<br />
											{apiKey.expiresAt ? `Expires ${formatDate(apiKey.expiresAt)}` : "No expiry"}
										</TableCell>
										<TableCell className="hidden text-muted-foreground sm:table-cell">
											{formatDate(apiKey.createdAt)}
										</TableCell>
										<TableCell className="hidden text-muted-foreground sm:table-cell">
											{apiKey.lastUsedAt ? formatRelative(apiKey.lastUsedAt) : "Never"}
										</TableCell>
										<TableCell className="pr-2 text-right">
											{apiKey.revokedAt ? (
												<BadgeStatus status="revoked" />
											) : (
												<ButtonRevokeApiKey id={apiKey._id.toString()} name={apiKey.name} />
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}

				<section style={{ "--stagger": 1 }} className="flex flex-col gap-3 animate-enter">
					<h2 className="text-sm font-medium text-muted-foreground">Usage</h2>
					{examples.map(({ title, code }) => (
						<div key={title} className="overflow-hidden rounded-xl bg-card shadow-border">
							<div className="flex h-10 items-center justify-between border-b border-border/60 pr-2 pl-4">
								<span className="text-sm">{title}</span>
								<ButtonCopy value={code} label="Copy" />
							</div>
							<pre className="overflow-x-auto p-4 font-mono text-xs leading-5 text-muted-foreground">
								{code}
							</pre>
						</div>
					))}
				</section>
			</div>
		</>
	);
}

function getExamples(appUrl) {
	return [
		{
			title: "Add a contact",
			code: `curl -X POST ${appUrl}/api/v1/contacts \\
  -H "Authorization: Bearer $VIBELETTER_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"newsletter":"weekly","email":"jane@example.com","source":"website"}'`,
		},
		{
			title: "Create a draft campaign",
			code: `curl -X POST ${appUrl}/api/v1/campaigns \\
  -H "Authorization: Bearer $VIBELETTER_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"newsletter":"weekly","subject":"This week","previewText":"...","html":"<html>...</html>"}'`,
		},
	];
}
