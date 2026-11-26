const config = JSON.parse(
  document.getElementById("nakara-config")?.textContent ?? "{}",
);
export const basePath: string = config.basePath ?? "";
/** The registered factories, oldest first; the first is the default. */
export const factories: {
  slug: string;
  name: string;
  description: string | null;
  avatarColor: string;
  paused: boolean;
}[] = config.factories ?? [];
export const defaultFactory = factories[0] ?? {
  slug: "default",
  name: "Default",
  description: null,
  avatarColor: "",
  paused: false,
};
export const serverUrl = (path: string) => `${basePath}${path}`;
