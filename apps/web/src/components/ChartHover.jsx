"use client";

import { useState } from "react";
import SwatchChart from "@/components/SwatchChart";
import { cn } from "@/lib/utils";

// Hover layer over a server-drawn chart: the closest point's rows in a tooltip, with a guide line, or a
// band as wide as `band` for bars. Points carry x and dot heights from 0 to 1, and preformatted rows.
export default function ChartHover({ points, band }) {
	const [index, setIndex] = useState(null);
	const point = index === null ? null : points[index];

	function track(event) {
		const { left, width } = event.currentTarget.getBoundingClientRect();
		setIndex(closestIndex(points, (event.clientX - left) / width));
	}

	return (
		<div
			aria-hidden="true"
			className="absolute inset-0 touch-pan-y"
			onPointerMove={track}
			onPointerDown={track}
			onPointerLeave={() => setIndex(null)}
		>
			{point && (
				<>
					<span
						className={cn(
							"pointer-events-none absolute inset-y-0 -translate-x-1/2",
							band ? "rounded-md bg-foreground/[0.05]" : "w-px bg-foreground/20"
						)}
						style={{ left: percent(point.x), width: band ? percent(band) : undefined }}
					/>
					{point.dots?.map(({ y, className }) => (
						<span
							key={className}
							className={cn(
								"pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card",
								className
							)}
							style={{ left: percent(point.x), top: percent(1 - y) }}
						/>
					))}
					<div
						className="pointer-events-none absolute top-0 z-10 flex min-w-36 flex-col gap-1.5 rounded-lg bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-lg ring-1 ring-border/70"
						style={{
							left: percent(point.x),
							transform: point.x < 0.5 ? "translateX(14px)" : "translateX(calc(-100% - 14px))",
						}}
					>
						<p className="font-medium">{point.title}</p>
						{point.rows.map(({ label, value, swatch }) => (
							<p key={label} className="flex items-center justify-between gap-4">
								<span className="flex items-center gap-2 text-muted-foreground">
									{swatch && <SwatchChart kind={swatch} />}
									{label}
								</span>
								<span className="font-medium tabular-nums">{value}</span>
							</p>
						))}
					</div>
				</>
			)}
		</div>
	);
}

function closestIndex(points, x) {
	return points.reduce(
		(best, point, index) => (Math.abs(point.x - x) < Math.abs(points[best].x - x) ? index : best),
		0
	);
}

function percent(ratio) {
	return `${ratio * 100}%`;
}
