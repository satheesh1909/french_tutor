import { NextResponse } from "next/server";
import { hasClaudeCredentials } from "@/lib/claude";
import { config } from "@/lib/config";
import { hasGeminiKey } from "@/lib/gemini";
import { ollamaStatus } from "@/lib/ollama";

/** Which of the three AI services are ready, so the UI can explain what's missing. */
export async function GET() {
  return NextResponse.json({
    claude: hasClaudeCredentials(),
    gemini: hasGeminiKey(),
    ollama: await ollamaStatus(),
    tutorName: config.tutorName,
  });
}
