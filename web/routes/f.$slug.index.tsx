import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/f/$slug/")({
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/f/$slug/activity",
      params,
      search,
      replace: true,
    });
  },
});
