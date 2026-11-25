import { useQuery } from "@tanstack/react-query";
import { factoriesQuery } from "../lib/api";
import { factories } from "./runtime";

/** The registered factories, refreshed as they are renamed or deleted. */
export const useFactories = () => useQuery(factoriesQuery).data;

/** A factory's avatar: its initial on its color. */
export function FactoryAvatar({
  name,
  color,
}: {
  name: string;
  color: string;
}) {
  return (
    <span
      className="factory-avatar"
      style={color ? { backgroundColor: color } : undefined}
      aria-hidden="true"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** A ?factory= search value: a registered factory's slug, or none. */
export const factorySearch = (value: unknown): string | undefined =>
  factories.find((f) => f.slug === value)?.slug;

/** The factory filter of the pages that span factories; hidden while only one exists. */
export function FactoryFilter({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (slug: string | undefined) => void;
}) {
  const factories = useFactories();
  if (factories.length < 2) return null;
  return (
    <label className="flex items-center gap-sm text-small text-muted">
      Factory
      <select
        aria-label="Factory"
        className="rounded-control border border-line bg-bg px-sm py-xs text-small text-text"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">All factories</option>
        {factories.map((factory) => (
          <option key={factory.slug} value={factory.slug}>
            {factory.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Which factory a row belongs to; nothing while only one factory exists. */
export function FactoryTag({ slug }: { slug: string }) {
  const factories = useFactories();
  const factory = factories.find((f) => f.slug === slug);
  if (factories.length < 2 || !factory) return null;
  return (
    <span className="flex shrink-0 items-center gap-xs text-small text-muted">
      <FactoryAvatar name={factory.name} color={factory.avatarColor} />
      {factory.name}
    </span>
  );
}
