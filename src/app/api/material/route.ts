import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { readMaterials, withLock, writeMaterials } from "@/lib/store";
import { MATERIAL_MAX_CHARS, type Material } from "@/lib/types";

/**
 * Texts the student brings to a lesson. They are kept so one article can seed a conversation today
 * and a lesson next week, rather than being pasted again each time.
 */

const MAX_KEPT = 50;

export async function GET() {
  try {
    // The text itself is only needed once a session starts, so the list stays small to send.
    const materials = await readMaterials();
    return NextResponse.json({ materials: materials.map(({ text, ...rest }) => ({ ...rest, preview: text.slice(0, 160) })) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { title?: unknown; text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return NextResponse.json({ error: "Paste some text first." }, { status: 400 });
    if (text.length > MATERIAL_MAX_CHARS) {
      return NextResponse.json(
        { error: `That's ${text.length.toLocaleString()} characters; the limit is ${MATERIAL_MAX_CHARS.toLocaleString()}. Try one section at a time.` },
        { status: 413 },
      );
    }
    // A title is only a label; the first line does when nobody supplies one.
    const given = typeof body.title === "string" ? body.title.trim() : "";
    const title = (given || text.split("\n")[0]).slice(0, 80) || "Untitled";

    const material: Material = {
      id: crypto.randomUUID(),
      title,
      text,
      addedAt: new Date().toISOString(),
      lastUsedAt: null,
      words: text.split(/\s+/).filter(Boolean).length,
    };
    await withLock(async () => {
      const materials = await readMaterials();
      materials.unshift(material);
      await writeMaterials(materials.slice(0, MAX_KEPT));
    });
    const { text: _full, ...summary } = material;
    return NextResponse.json({ material: { ...summary, preview: material.text.slice(0, 160) } });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Which text?" }, { status: 400 });
    const removed = await withLock(async () => {
      const materials = await readMaterials();
      const keep = materials.filter((m) => m.id !== id);
      if (keep.length === materials.length) return false;
      await writeMaterials(keep);
      return true;
    });
    if (!removed) return NextResponse.json({ error: "That text is already gone." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
