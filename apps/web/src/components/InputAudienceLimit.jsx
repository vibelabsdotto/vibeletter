import { Input } from "@/components/ui/input";
import { formatNumber } from "@/lib/format";

// Warm-up: a limit sends to the most engaged contacts first.
export default function InputAudienceLimit({ value, onChange, audienceCount, label = "Limit" }) {
	return (
		<label className="flex flex-col gap-1.5">
			<span className="text-sm text-muted-foreground">{label}</span>
			<Input
				type="number"
				min={1}
				inputMode="numeric"
				value={value}
				placeholder={`All ${formatNumber(audienceCount)}`}
				onChange={(event) => onChange(event.target.value)}
			/>
		</label>
	);
}

export function countRecipients(limit, audienceCount) {
	const limitNumber = Number.parseInt(limit, 10);
	return limitNumber > 0 ? Math.min(limitNumber, audienceCount) : audienceCount;
}
