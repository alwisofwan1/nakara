import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { agentsQuery, loadPage } from "../lib/api";
import { EmptyState } from "../ui/empty-state";
import { Icon } from "../ui/icons";

export const Route = createFileRoute("/f/$slug/agents/")({
  loader: ({ context, params }) =>
    loadPage(context.queryClient, agentsQuery(params.slug)),
  component: Agents,
  staticData: { title: "Agents" },
});
function Agents() {
  const { slug } = Route.useParams();
  const { data } = useSuspenseQuery(agentsQuery(slug));
  return (
    <section>
      <h1 className="mb-xl text-heading font-semibold">Agents</h1>
      {!data.length ? (
        <EmptyState
          icon="bot"
          title="No agents"
          action={
            <Link
              to="/f/$slug/agents/new"
              params={{ slug }}
              className="primary flex items-center gap-xs"
            >
              <Icon name="plus" className="h-icon w-icon" />
              New agent
            </Link>
          }
        >
          A factory needs a foreman. Start from the example tree or create one.
        </EmptyState>
      ) : (
        <>
          <ul className="agent-tree">
            {data.map((agent) => (
              <li
                key={agent.name}
                className={agent.type === "FOREMAN" ? "" : "agent-child"}
              >
                <Link
                  className="agent-card"
                  to="/f/$slug/agents/$name"
                  params={{ slug, name: agent.name }}
                >
                  <span
                    className={`agent-tile agent-${agent.type.toLowerCase()}`}
                    aria-hidden="true"
                  >
                    {agent.type === "FOREMAN" ? "◇" : "⌘"}
                  </span>
                  <span className="agent-name">
                    <strong>{agent.name}</strong>
                    <span className="block text-small text-muted">
                      {agent.description}
                    </span>
                  </span>
                  <span className="agent-chip">
                    {agent.harness}
                    {agent.model && ` · ${agent.model}`}
                  </span>
                  <span aria-hidden="true">›</span>
                </Link>
              </li>
            ))}
          </ul>
          <Link
            to="/f/$slug/agents/new"
            params={{ slug }}
            className="new-agent"
          >
            + New agent
          </Link>
        </>
      )}
    </section>
  );
}
