import type { Metadata } from "next";
import { ProgressApp } from "@/components/ProgressApp";

export const metadata: Metadata = { title: "Progress · French tutor" };

export default function ProgressPage() {
  return <ProgressApp />;
}
