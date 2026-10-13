"use server";

import { redirect } from "next/navigation";
import { endSession } from "@/lib/auth";

export async function logout() {
	await endSession();
	redirect("/login");
}
