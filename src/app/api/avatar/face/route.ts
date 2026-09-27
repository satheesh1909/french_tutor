import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { errorResponse } from "@/lib/http";
import { addFace, removeFace } from "@/lib/providers/avatar";

const NAME = /^[\w-]{1,60}$/;
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * Takes a new portrait for her. The photo is handed to the lip-sync server, which finds the face in
 * it and keeps it: a photo with no face it can use is refused here rather than saved and discovered
 * to be useless later.
 */
export async function POST(req: Request) {
  try {
    const name = new URL(req.url).searchParams.get("name")?.trim() ?? "";
    if (!NAME.test(name)) {
      return NextResponse.json({ error: "Give the photo a name of letters, digits, dashes or underscores." }, { status: 400 });
    }
    const image = Buffer.from(await req.arrayBuffer());
    if (image.length === 0) return NextResponse.json({ error: "No photo was sent." }, { status: 400 });
    if (image.length > MAX_BYTES) return NextResponse.json({ error: "That photo is too large. Keep it under 12 MB." }, { status: 413 });

    return NextResponse.json(await addFace(name, image));
  } catch (err) {
    return errorResponse(err);
  }
}

/** Forgets a portrait and deletes it. The last one can't be removed; the server enforces that. */
export async function DELETE(req: Request) {
  try {
    const name = new URL(req.url).searchParams.get("name")?.trim() ?? "";
    if (!NAME.test(name)) return NextResponse.json({ error: "That is not a photo name." }, { status: 400 });
    return NextResponse.json(await removeFace(name));
  } catch (err) {
    return errorResponse(err);
  }
}

/** Serves the still photo the avatar wears, so the page can show her while she isn't speaking. */
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("name") ?? "charlotte";
  if (!NAME.test(name)) return NextResponse.json({ error: "Unknown photo." }, { status: 400 });

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
