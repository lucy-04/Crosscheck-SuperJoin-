import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crosscheck — fact knowledge layer",
  description: "Extracts scoped claims from documents and explains where they agree and disagree.",
};

const NAV = [
  { href: "/", label: "Documents" },
  { href: "/relations", label: "Relations" },
  { href: "/facts", label: "Facts" },
  { href: "/registry", label: "Vocabulary" },
  { href: "/quarantine", label: "Quarantine" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-baseline gap-x-6 gap-y-2 px-6 py-3">
            <Link href="/" className="text-[15px] font-semibold tracking-tight">
              Crosscheck
            </Link>
            <span className="text-[12px] text-[var(--color-muted)]">
              a fact knowledge layer that explains its disagreements
            </span>
            <nav className="ml-auto flex gap-4 text-[13px]">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-[1400px] px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
