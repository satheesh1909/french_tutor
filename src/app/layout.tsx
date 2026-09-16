import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { NavLinks } from "@/components/NavLinks";
import { config } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = {
  title: `${config.tutorName} · French tutor`,
  description: "Your personal French tutor, from A2 to B1 and B2.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="topbar__inner">
            <Link href="/" className="brand">
              <span className="brand__mark" aria-hidden="true">
                {config.tutorName.charAt(0)}
              </span>
              {config.tutorName}
              <span className="brand__sub">French tutor</span>
            </Link>
            <NavLinks />
          </div>
        </header>
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
