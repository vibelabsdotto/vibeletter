"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const INITIAL_HEIGHT = 800;

// HTML issues with their own design (tables, inline styles) render as sent, sized to their content.
export default function FrameIssue({ html, className }) {
	const frameRef = useRef(null);
	const [height, setHeight] = useState(INITIAL_HEIGHT);

	// Text reflows when a phone rotates or the window narrows, so a new width measures again.
	useEffect(() => {
		const frame = frameRef.current;
		const box = frame.parentElement;
		let width = box.clientWidth;
		const observer = new ResizeObserver(() => {
			if (box.clientWidth === width) return;
			width = box.clientWidth;
			const next = fitToWidth(frame);
			if (next) setHeight(next);
		});
		observer.observe(box);
		return () => observer.disconnect();
	}, []);

	return (
		<div style={{ height }} className={cn("overflow-hidden rounded-xl bg-white", className)}>
			<iframe
				ref={frameRef}
				title="Issue"
				srcDoc={html}
				// Same origin lets the page read the issue's height; without allow-scripts nothing in it runs.
				sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
				onLoad={(event) => setHeight(fitToWidth(event.currentTarget) ?? INITIAL_HEIGHT)}
				className="block size-full origin-top-left"
			/>
		</div>
	);
}

// The email lays out at the box's width. One that can't fit (a wide table) keeps the width it needs and
// shrinks to fit, the way mail apps show it, instead of losing its right side. Measuring at zero
// height keeps an email sized to the frame's own height from growing it on every pass.
function fitToWidth(frame) {
	const root = frame.contentDocument?.documentElement;
	if (!root) return null;
	const available = frame.parentElement.clientWidth;
	Object.assign(frame.style, { width: `${available}px`, height: "0px", transform: "" });
	const width = Math.max(root.scrollWidth, available);
	frame.style.width = `${width}px`;
	const height = root.scrollHeight;
	const scale = available / width;
	Object.assign(frame.style, { height: `${height}px`, transform: scale < 1 ? `scale(${scale})` : "" });
	return Math.ceil(height * scale);
}
