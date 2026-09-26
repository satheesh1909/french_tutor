import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";

/** Serves the still photo the avatar wears, so the page can show her while she isn't speaking. */
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("name") ?? "charlotte";
  if (!/^[\w-]{1,60}$/.test(name)) return NextResponse.json({ error: "Unknown photo." }, { status: 400 });

  for (const extension of ["jpg", "png"]) {
    const file = path.join(config.avatar.facesDir, `${name}.${extension}`);
    try {
      const image = await fs.readFile(file);
      return new Response(new Uint8Array(image), {
        headers: { "content-type": extension === "png" ? "image/png" : "image/jpeg", "cache-control": "no-cache" },
      });
    } catch {
      // try the next extension
    }
  }
  return NextResponse.json({ error: "That photo isn't in avatar_server/faces." }, { status: 404 });
}
