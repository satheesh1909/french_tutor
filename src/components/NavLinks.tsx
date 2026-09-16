"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Tutor" },
  { href: "/practice", label: "Practice" },
  { href: "/progress", label: "Progress" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((link) => {
        const current = pathname === link.href;
        return (
          <Link key={link.href} href={link.href} className={`nav__link${current ? " nav__link--active" : ""}`} aria-current={current ? "page" : undefined}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
