import Link from "next/link";
import LogoVibeLetter from "@/components/LogoVibeLetter";
import { APP_NAME } from "@/lib/brand";
import NavFooter from "@/components/NavFooter";
import NavLinks from "@/components/NavLinks";
import NavMobile from "@/components/NavMobile";
import { requireSession } from "@/lib/auth";

export default async function AppLayout({ children }) {
	await requireSession();

	return (
		<div className="flex min-h-dvh flex-col md:flex-row">
			<aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border/60 px-3 py-4 md:flex">
				<Link href="/" className="mb-6 flex h-9 items-center gap-2 px-2.5">
					<LogoVibeLetter />
					<span className="text-sm font-semibold tracking-tight">{APP_NAME}</span>
				</Link>
				<NavLinks />
				<div className="mt-auto">
					<NavFooter />
				</div>
			</aside>
			<NavMobile footer={<NavFooter />} />
			<main className="min-w-0 flex-1">
				<div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-10 md:py-10">{children}</div>
			</main>
		</div>
	);
}
