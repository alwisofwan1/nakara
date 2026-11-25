import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/** Shown in place of a page's list, with at most one next step. */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state" aria-label={title}>
      <span className="empty-state-icon">
        <Icon name={icon} className="h-xl w-xl" />
      </span>
      <h2 className="text-body font-bold">{title}</h2>
      <p className="max-w-modal text-small text-muted">{children}</p>
      {action}
    </section>
  );
}
