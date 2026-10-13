export function getIssueDate(issue) {
	return issue?.sentAt || issue?.startedAt || null;
}
