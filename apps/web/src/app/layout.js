import { Geist, Geist_Mono } from "next/font/google";
import ProviderTheme from "@/components/ProviderTheme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_DESCRIPTION, APP_NAME, COMPANY_NAME } from "@/lib/brand";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// The icon files in app/ apply wherever a page sets no icons; archive pages set the newsletter's logo.
// favicon.ico sits in public/ because Next links app/favicon.ico on every page, archive pages included.
export const metadata = {
	title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
	applicationName: APP_NAME,
	description: APP_DESCRIPTION,
	creator: COMPANY_NAME,
	publisher: COMPANY_NAME,
	robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
	return (
		<html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
			<body className="min-h-dvh bg-background text-foreground">
				<ProviderTheme>
					<TooltipProvider delayDuration={200}>{children}</TooltipProvider>
					<Toaster position="bottom-right" />
				</ProviderTheme>
			</body>
		</html>
	);
}
