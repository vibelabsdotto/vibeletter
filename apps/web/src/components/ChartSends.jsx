import { Suspense } from "react";
import ChartFrame from "@/components/ChartFrame";
import ChartHover from "@/components/ChartHover";
import { niceScale, toRatio } from "@/lib/charts";
import { formatHour, formatNumber } from "@/lib/format";

// Emails sent in each hour of today, in front of yesterday's as faint bars. Hours to come show only yesterday.
export default function ChartSends({ hours }) {
	const scale = niceScale([0, ...hours.flatMap(({ today, yesterday }) => [today ?? 0, yesterday])], 3);
	const xOf = (hour) => (hour + 0.5) / hours.length;
	const sentToday = hours.reduce((sum, { today }) => sum + (today ?? 0), 0);

	const points = hours.map(({ hour, today, yesterday }) => ({
		x: xOf(hour),
		title: `${formatHour(hour)} – ${formatHour((hour + 1) % 24)}`,
		rows: [
			today !== null && { label: "Today", value: formatNumber(today), swatch: "bar" },
			{ label: "Yesterday", value: formatNumber(yesterday), swatch: "ghost" },
		].filter(Boolean),
	}));
	const xLabels = [0, 6, 12, 18, 23].map((hour) => ({
		x: xOf(hour),
		label: formatHour(hour),
		className: hour === 23 ? "hidden sm:block" : undefined,
	}));

	return (
		<ChartFrame scale={scale} xLabels={xLabels} className="h-36 sm:h-44">
			<div
				role="img"
				aria-label={`${formatNumber(sentToday)} emails sent today`}
				className="absolute inset-0 flex items-end gap-[3px] sm:gap-1.5"
			>
				{hours.map(({ hour, today, yesterday }) => (
					<div key={hour} className="relative h-full flex-1">
						<span
							className="absolute inset-x-0 bottom-0 rounded-t-[3px] bg-muted-foreground/15"
							style={{ height: `${toRatio(yesterday, scale) * 100}%` }}
						/>
						{today > 0 && (
							<span
								className="absolute inset-x-0 bottom-0 min-h-0.5 rounded-t-[3px] bg-foreground"
								style={{ height: `${toRatio(today, scale) * 100}%` }}
							/>
						)}
					</div>
				))}
			</div>
			{sentToday === 0 && (
				<p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground">
					No emails sent today
				</p>
			)}
			<Suspense fallback={null}>
				<ChartHover points={points} band={1 / hours.length} />
			</Suspense>
		</ChartFrame>
	);
}
