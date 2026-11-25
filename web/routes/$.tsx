import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { defaultFactory } from "../app/runtime";

/** Factory pages that moved under /f/<slug>/; the server redirects full page loads too. */
const FACTORY_PAGE = /^\/(?:activity|agents|automations|definition)(?:\/|$)/;

export const Route = createFileRoute("/$")({
  // Old links to factory pages open the first factory's page.
  beforeLoad: ({ params, search }) => {
    const path = `/${params._splat ?? ""}`;
    if (!FACTORY_PAGE.test(path)) throw notFound();
    throw redirect({
      // The rest of the old path is literal: /agents/review → /f/<slug>/agents/review.
      to: `/f/$slug${path}` as "/f/$slug/activity",
      params: { slug: defaultFactory.slug },
      search,
      replace: true,
    });
  },
});
