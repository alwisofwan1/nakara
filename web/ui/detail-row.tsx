/** A labelled row of an agent form; `inherited` marks a value agentDefaults supplies. */
export function DetailRow({
  label,
  hint,
  inherited,
  children,
}: {
  label: string;
  hint?: string;
  inherited?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="detail-row">
      <dt className="grid gap-xs">
        <span className="flex items-center gap-sm text-muted">
          {label}
          {inherited && <span className="agent-chip">Default</span>}
        </span>
        {hint && <span className="field-hint">{hint}</span>}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
