"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export default function ButtonThemeToggle() {
	const { resolvedTheme, setTheme } = useTheme();

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Toggle theme"
					onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
				>
					<Sun className="animate-icon-in dark:hidden" />
					<Moon className="hidden animate-icon-in dark:block" />
				</Button>
			</TooltipTrigger>
			<TooltipContent>Theme</TooltipContent>
		</Tooltip>
	);
}
