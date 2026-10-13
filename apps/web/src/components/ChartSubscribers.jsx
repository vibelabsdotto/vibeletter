import { Suspense } from "react";
import ChartFrame from "@/components/ChartFrame";
import ChartHover from "@/components/ChartHover";
import { areaPath, linePath, niceScale, toRatio } from "@/lib/charts";
import { formatNumber } from "@/lib/format";
import { formatDateKey } from "@/lib/time-zone";

// The SVG stretches to the plot; strokes keep their width with non-scaling-stroke.
const BOX = { width: 600, height: 200 };

// Subscribers at the end of each day of the period, over the period before as a dashed line.
export default function ChartSubscribers({ current, previous }) {
	const values = current.map(({ total }) => total);
	const previousValues = previous.map(({ total }) => total);
	const scale = niceScale([...values, ...previousValues]);
	const xOf = (index) => (current.length > 1 ? index / (current.length - 1) : 0);
	const last = current.at(-1);

	const points = current.map((day, index) => {
		const before = previous[index];
		return {
			x: xOf(index),
			title: formatDateKey(day.key, { weekday: "short", month: "short", day: "numeric" }),
			rows: [
				{ label: "Subscribers", value: formatNumber(day.total), swatch: "line" },
				{ label: "Joined", value: formatNumber(day.joined) },
				{ label: "Left", value: formatNumber(day.left) },
				before && { label: formatDateKey(before.key), value: formatNumber(before.total), swatch: "dashed" },
			].filter(Boolean),
			dots: [
				before && { y: toRatio(before.total, scale), className: "bg-muted-foreground" },
				{ y: toRatio(day.total, scale), className: "bg-foreground" },
			].filter(Boolean),
		};
	});

	// A label every 7 days, ending today; every other one on small screens.
	const xLabels = [];
	for (let index = current.length - 1, position = 0; index >= 0; index -= 7, position += 1) {
		xLabels.push({
			x: xOf(index),
			label: formatDateKey(current[index].key),
			className: position % 2 ? "hidden sm:block" : undefined,
		});
	}

	return (
		<ChartFrame scale={scale} xLabels={xLabels} className="h-52 sm:h-64">
			<div
				role="img"
				aria-label={`Subscribers from ${formatDateKey(current[0].key)} to ${formatDateKey(last.key)}: ${formatNumber(current[0].total)} to ${formatNumber(last.total)}`}
				className="absolute inset-0"
			>
				<svg
					viewBox={`0 0 ${BOX.width} ${BOX.height}`}
					preserveAspectRatio="none"
					className="absolute inset-0 size-full overflow-visible"
				>
					<defs>
						<linearGradient id="chart-subscribers-fill" x1="0" x2="0" y1="0" y2="1">
							<stop offset="0%" stopColor="currentColor" stopOpacity="0.1" />
							<stop offset="100%" stopColor="currentColor" stopOpacity="0" />
						</linearGradient>
					</defs>
					<path
						d={linePath(previousValues, scale, BOX)}
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeDasharray="3 4"
						vectorEffect="non-scaling-stroke"
						className="text-muted-foreground/50"
					/>
					<path d={areaPath(values, scale, BOX)} fill="url(#chart-subscribers-fill)" className="text-foreground" />
					<path
						d={linePath(values, scale, BOX)}
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						vectorEffect="non-scaling-stroke"
						className="text-foreground"
					/>
				</svg>
				<span
					className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-4 ring-foreground/10"
					style={{ left: "100%", top: `${(1 - toRatio(last.total, scale)) * 100}%` }}
				/>
			</div>
			<Suspense fallback={null}>
				<ChartHover points={points} />
			</Suspense>
		</ChartFrame>
	);
}
