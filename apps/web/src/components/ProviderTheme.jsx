"use client";

import { ThemeProvider } from "next-themes";

export default function ProviderTheme({ children }) {
	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
			{children}
		</ThemeProvider>
	);
}
