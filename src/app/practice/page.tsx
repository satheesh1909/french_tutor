import type { Metadata } from "next";
import { PracticeApp } from "@/components/PracticeApp";

export const metadata: Metadata = { title: "Practice · French tutor" };

export default function PracticePage() {
  return <PracticeApp />;
}
