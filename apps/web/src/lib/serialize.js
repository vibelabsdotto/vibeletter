// Mongoose documents carry ObjectIds and Dates that cannot cross into client components.
export function serialize(value) {
	return JSON.parse(JSON.stringify(value));
}
