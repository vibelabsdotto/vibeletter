"use client";

import { useState } from "react";
import Image from "next/image";
import { faviconUrl } from "@/lib/favicon";
import { cn } from "@/lib/utils";

// Google answers domains it has no icon for with a 16px globe, which says less than the initial
// underneath, so only real logos show. The icons load eagerly: a lazy image the browser hasn't
// fetched yet can count as complete at hydration, and next/image would then report it with no size.
const MIN_LOGO_WIDTH = 32;

export default function ImageDomainLogo({ domain, size }) {
	const [isLogo, setIsLogo] = useState(false);

	return (
		<span
			className={cn(
				"absolute inset-0 grid place-items-center bg-muted opacity-0 transition-opacity duration-200",
				isLogo && "opacity-100"
			)}
		>
			<Image
				src={faviconUrl(domain, 64)}
				alt=""
				width={size}
				height={size}
				unoptimized
				loading="eager"
				onLoad={(event) => setIsLogo(event.currentTarget.naturalWidth >= MIN_LOGO_WIDTH)}
				className="rounded-[4px]"
			/>
		</span>
	);
}
