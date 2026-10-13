// A missing value: a short faded line sized to the surrounding text, so it fits table cells and stat cards.
export default function TextEmpty({ label = "None" }) {
	return (
		<span className="inline-block h-[max(1px,0.07em)] w-[0.6em] rounded-full bg-muted-foreground/40 align-middle">
			<span className="sr-only">{label}</span>
		</span>
	);
}
