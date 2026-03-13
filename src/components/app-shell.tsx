"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { ThemeToggle } from "./theme-toggle";
import styles from "./app-shell.module.css";

type AppShellProps = {
  eyebrow: string;
  title: string;
  description?: string;
  status?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
};

const NAV_ITEMS = [
  { href: "/connect", label: "Gateway" },
  { href: "/", label: "Live" },
  { href: "/logs", label: "Logs" },
];

export function AppShell({
  eyebrow,
  title,
  description,
  status,
  children,
  contentClassName,
}: AppShellProps) {
  const pathname = usePathname();

  return (
    <section className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topRail}>
          <div className={styles.brandBlock}>
            <span className={styles.brand}>Gym Motion</span>
            <span className={styles.environment}>Operator console</span>
          </div>

          <div className={styles.railControls}>
            <nav className={styles.nav}>
              {NAV_ITEMS.map((item) => {
                const isActive =
                  item.href === "/" ? pathname === "/" : pathname?.startsWith(item.href);

                return (
                  <Link
                    className={styles.navLink}
                    data-active={isActive}
                    href={item.href}
                    key={item.href}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <ThemeToggle />
          </div>
        </header>

        <div className={styles.hero}>
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow}>{eyebrow}</div>
            <h1 className={styles.title}>{title}</h1>
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          {status ? <div className={styles.statusSlot}>{status}</div> : null}
        </div>

        <div className={[styles.content, contentClassName].filter(Boolean).join(" ")}>
          {children}
        </div>
      </div>
    </section>
  );
}
