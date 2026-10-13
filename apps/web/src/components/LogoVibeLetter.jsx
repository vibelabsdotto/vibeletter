import { cn } from "@/lib/utils";

export default function LogoVibeLetter({ className }) {
	return (
		<svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-6 shrink-0", className)}>
			<rect width="32" height="32" rx="9" className="fill-brand-coral" />
			<g fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="stroke-brand-ink">
				<rect x="8" y="10" width="16" height="12" rx="2.5" />
				<path d="m9 12 7 5 7-5" />
			</g>
		</svg>
	);
}
