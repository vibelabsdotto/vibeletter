import { useSyncExternalStore } from "react";

function subscribe() {
	return () => {};
}

// False while rendering on the server, which doesn't know the visitor's timezone; true in the browser.
export function useIsClient() {
	return useSyncExternalStore(
		subscribe,
		() => true,
		() => false
	);
}
