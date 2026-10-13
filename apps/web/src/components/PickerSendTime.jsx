"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const DAYS_SHOWN = 14;
const MINUTES_PER_DAY = 24 * 60;
const DEFAULT_MINUTES = [9 * 60, 12 * 60, 18 * 60];
const MAX_USUAL_TIMES = 3;
const MAX_TIMES = 5;

// Times are the browser's local time; history and suggestions come in as instants.
export default function PickerSendTime({ value, onChange, suggestions, history }) {
	const now = new Date();
	const today = startOfDay(now);
	const days = Array.from({ length: DAYS_SHOWN }, (_, index) => addDays(today, index));
	const usualDays = new Set(history.map((at) => new Date(at).getDay()));
	const usualMinutes = getUsualMinutes(history);
	const times = [...new Set([...usualMinutes, ...DEFAULT_MINUTES])].slice(0, MAX_TIMES).sort((a, b) => a - b);
	const minutes = minutesOf(value);
	const selectedDay = startOfDay(value).getTime();
	const isToday = selectedDay === today.getTime();

	return (
		<div className="flex flex-col gap-5">
			{suggestions.length > 0 && (
				<Field label="Suggested">
					<ListSuggestions suggestions={suggestions} value={value} now={now} onChange={onChange} />
				</Field>
			)}
			<Field label="Day">
				<div role="radiogroup" aria-label="Day" className="grid grid-cols-7 gap-1">
					{days.map((day, index) => (
						<ButtonDay
							key={day.getTime()}
							day={day}
							isToday={index === 0}
							isSelected={day.getTime() === selectedDay}
							isUsual={usualDays.has(day.getDay())}
							onSelect={() => onChange(atMinutes(day, minutes))}
						/>
					))}
				</div>
			</Field>
			<Field label="Time">
				<div role="radiogroup" aria-label="Time" className="flex flex-wrap items-center gap-1.5">
					{times.map((time) => (
						<ChipTime
							key={time}
							minutes={time}
							isSelected={time === minutes}
							isUsual={usualMinutes.includes(time)}
							isPast={isToday && atMinutes(value, time) <= now}
							onSelect={() => onChange(atMinutes(value, time))}
						/>
					))}
					<input
						type="time"
						step={300}
						value={toTimeValue(minutes)}
						onChange={(event) => event.target.value && onChange(atMinutes(value, fromTimeValue(event.target.value)))}
						aria-label="Other time"
						className="h-8 rounded-full bg-transparent px-3 text-sm tabular-nums shadow-border outline-none [color-scheme:light_dark] focus-visible:ring-2 focus-visible:ring-ring/50"
					/>
				</div>
			</Field>
			{(usualDays.size > 0 || usualMinutes.length > 0) && (
				<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<DotUsual />
					When past issues went out
				</p>
			)}
		</div>
	);
}

function ListSuggestions({ suggestions, value, now, onChange }) {
	return (
		<div role="radiogroup" aria-label="Suggested times" className="overflow-hidden rounded-xl shadow-border">
			{suggestions.map((suggestion) => {
				const isSelected = suggestion.at.getTime() === value.getTime();
				return (
					<button
						key={suggestion.at.getTime()}
						type="button"
						role="radio"
						aria-checked={isSelected}
						onClick={() => onChange(suggestion.at)}
						className={cn(
							"flex w-full items-center justify-between gap-3 border-b border-border/60 px-3.5 py-2.5 text-left transition-colors duration-150 last:border-b-0 hover:bg-muted/60",
							isSelected && "bg-muted hover:bg-muted"
						)}
					>
						<span className="min-w-0">
							<span className="block text-sm font-medium tabular-nums">
								{formatDay(suggestion.at, now)} · {formatTime(suggestion.at)}
							</span>
							<span className="block truncate text-xs text-muted-foreground">
								{suggestion.isLastIssue
									? "Same time as your last issue"
									: `Like your ${formatShortDate(suggestion.lastUsedAt)} issue`}
							</span>
						</span>
						{isSelected && <Check aria-hidden="true" className="size-4 shrink-0" />}
					</button>
				);
			})}
		</div>
	);
}

function ButtonDay({ day, isToday, isSelected, isUsual, onSelect }) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={isSelected}
			aria-label={day.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
			onClick={onSelect}
			className={cn(
				"relative flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg tabular-nums transition-colors duration-150",
				isSelected ? "bg-foreground text-background" : "hover:bg-muted"
			)}
		>
			<span className={cn("text-[11px] leading-none", !isSelected && "text-muted-foreground")}>
				{isToday ? "Today" : day.toLocaleDateString("en-US", { weekday: "short" })}
			</span>
			<span className="text-sm leading-none font-medium">{day.getDate()}</span>
			{isUsual && <DotUsual className="absolute bottom-1" isInverted={isSelected} />}
		</button>
	);
}

function ChipTime({ minutes, isSelected, isUsual, isPast, onSelect }) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={isSelected}
			disabled={isPast}
			onClick={onSelect}
			className={cn(
				"inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm tabular-nums transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40",
				isSelected ? "bg-foreground text-background" : "shadow-border hover:bg-muted"
			)}
		>
			{isUsual && <DotUsual isInverted={isSelected} />}
			{formatTime(atMinutes(new Date(), minutes))}
		</button>
	);
}

function Field({ label, children }) {
	return (
		<div className="flex flex-col gap-2">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}

function DotUsual({ className, isInverted = false }) {
	return (
		<span
			aria-hidden="true"
			className={cn("size-1 shrink-0 rounded-full", isInverted ? "bg-background" : "bg-sky-500", className)}
		/>
	);
}

function startOfDay(date) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, count) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

function minutesOf(date) {
	return date.getHours() * 60 + date.getMinutes();
}

function atMinutes(date, minutes) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60);
}

// Local times of past issues, newest first, on the quarter hour.
function getUsualMinutes(history) {
	const minutes = [];
	for (const at of history) {
		const rounded = (Math.round(minutesOf(new Date(at)) / 15) * 15) % MINUTES_PER_DAY;
		if (!minutes.includes(rounded)) minutes.push(rounded);
		if (minutes.length === MAX_USUAL_TIMES) break;
	}
	return minutes;
}

function toTimeValue(minutes) {
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function fromTimeValue(value) {
	const [hours, minutes] = value.split(":").map(Number);
	return hours * 60 + minutes;
}

function formatTime(date) {
	return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatShortDate(date) {
	return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDay(date, now) {
	const days = Math.round((startOfDay(date) - startOfDay(now)) / (24 * 60 * 60 * 1000));
	if (days === 0) return "Today";
	if (days === 1) return "Tomorrow";
	return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
