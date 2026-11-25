import { createFileRoute, redirect } from "@tanstack/react-router";
import { defaultFactory } from "../app/runtime";

export const Route = createFileRoute("/")({
  // Keep the search, so /?new=1 still opens the New work modal.
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/f/$slug/activity",
      params: { slug: defaultFactory.slug },
      search,
      replace: true,
    });
  },
});
