import type { Metadata } from "next";
import { SettingsApp } from "@/components/SettingsApp";

export const metadata: Metadata = { title: "Settings · French tutor" };

export default function SettingsPage() {
  return <SettingsApp />;
}
