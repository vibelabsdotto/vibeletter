const SENT_OR_SCHEDULED = ["scheduled", "sending", "paused", "sent"];

// When the other issues went out, newest first. A schedule counts as the time picked, before and
// after it sends.
export function sendTimesPipeline({ newsletterId, excludeId, limit = 20 }) {
	return [
		{ $match: { _id: { $ne: excludeId }, status: { $in: SENT_OR_SCHEDULED }, ...(newsletterId && { newsletterId }) } },
		{ $project: { status: 1, at: { $ifNull: ["$scheduledAt", "$startedAt", "$sentAt"] } } },
		{ $match: { at: { $type: "date" } } },
		{ $sort: { at: -1 } },
		{ $limit: limit },
	];
}

// The fields campaign lists show, picked before sorting: issues also carry their HTML and the data
// other sites render them from (up to 200 KB each).
const LIST_FIELDS = {
	newsletterId: 1,
	subject: 1,
	status: 1,
	stats: 1,
	thumbnailUrl: 1,
	archiveSlug: 1,
	scheduledAt: 1,
	startedAt: 1,
	sentAt: 1,
	updatedAt: 1,
};

// Sent issues sort by send date, scheduled ones by the time they go out (so upcoming sends lead) and
// drafts by their last edit: imported issues all share the import time as updatedAt and createdAt.
export function recentCampaignsPipeline(limit, newsletterId) {
	return [
		{ $match: { status: { $ne: "canceled" }, ...(newsletterId && { newsletterId }) } },
		{ $project: LIST_FIELDS },
		{
			$addFields: {
				activityAt: { $ifNull: ["$sentAt", "$startedAt", "$scheduledAt", "$updatedAt"] },
			},
		},
		{ $sort: { activityAt: -1, _id: -1 } },
		{ $limit: limit },
	];
}
