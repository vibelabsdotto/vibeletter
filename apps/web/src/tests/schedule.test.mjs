import assert from "node:assert/strict";
import { test } from "node:test";
import { getScheduleProblem, getScheduleSuggestions } from "../lib/schedule.js";

// Tuesday, Oct 6, 2026, 11:30 UTC.
const NOW = Date.parse("2026-10-06T11:30:00Z");
const WEEKLY = [
	"2026-09-30T13:00:00Z", // Wed
	"2026-09-23T13:00:00Z", // Wed
	"2026-08-31T13:00:00Z", // Mon
	"2026-08-25T13:00:00Z", // Tue
	"2026-08-18T13:00:00Z", // Tue
];

function times(suggestions) {
	return suggestions.map(({ at }) => at.toISOString());
}

test("past send times come back as the next time that weekday and hour come around", () => {
	const suggestions = getScheduleSuggestions({ history: WEEKLY, now: NOW });
	assert.deepEqual(times(suggestions), [
		"2026-10-06T13:00:00.000Z",
		"2026-10-07T13:00:00.000Z",
		"2026-10-12T13:00:00.000Z",
	]);
	const lastIssue = suggestions.find(({ isLastIssue }) => isLastIssue);
	assert.equal(lastIssue.at.toISOString(), "2026-10-07T13:00:00.000Z");
	assert.equal(lastIssue.uses, 2);
	assert.equal(lastIssue.lastUsedAt.toISOString(), "2026-09-30T13:00:00.000Z");
});

test("send-now times round to the quarter hour", () => {
	const suggestions = getScheduleSuggestions({ history: ["2026-09-08T08:40:12Z", "2026-09-01T13:14:00Z"], now: NOW });
	assert.deepEqual(times(suggestions), ["2026-10-06T13:15:00.000Z", "2026-10-13T08:45:00.000Z"]);
});

test("a slot about to pass, or taken by another scheduled issue, moves a week on", () => {
	const soon = getScheduleSuggestions({ history: ["2026-09-29T11:35:00Z"], now: NOW });
	assert.deepEqual(times(soon), ["2026-10-13T11:30:00.000Z"]);

	const taken = getScheduleSuggestions({
		history: ["2026-09-30T13:00:00Z"],
		taken: ["2026-10-07T13:00:00Z"],
		now: NOW,
	});
	assert.deepEqual(times(taken), ["2026-10-14T13:00:00.000Z"]);
});

test("no history means no suggestions", () => {
	assert.deepEqual(getScheduleSuggestions({ history: [], now: NOW }), []);
	assert.deepEqual(getScheduleSuggestions({ history: [null, "not a date"], now: NOW }), []);
});

test("a schedule must be in the future and within a year", () => {
	assert.equal(getScheduleProblem("2026-10-06T13:00:00Z", NOW), null);
	assert.equal(getScheduleProblem(new Date(NOW + 2 * 60 * 1000), NOW), null);
	assert.equal(getScheduleProblem(new Date(NOW + 30 * 1000), NOW), "Pick a time in the future");
	assert.equal(getScheduleProblem("2026-10-05T13:00:00Z", NOW), "Pick a time in the future");
	assert.equal(getScheduleProblem("2027-11-01T13:00:00Z", NOW), "Pick a time within a year");
	assert.equal(getScheduleProblem("tomorrow", NOW), "Pick a date and time");
	assert.equal(getScheduleProblem(undefined, NOW), "Pick a date and time");
});
