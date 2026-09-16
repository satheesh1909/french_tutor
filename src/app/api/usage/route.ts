import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { usageReport } from "@/lib/usage";

/** Token usage for today and this month, per provider, model and feature. */
export async function GET() {
  try {
    return NextResponse.json(await usageReport());
  } catch (err) {
    return errorResponse(err);
  }
}
