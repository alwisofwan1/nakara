# Browser runner image: the agent image plus playwright-cli and Chromium, so
# an agent can run the app in its workspace, drive it and screenshot it.
# Build after nakara-agent:
#   docker build -t nakara-agent-browser -f deploy/agent-browser.Dockerfile deploy
# The browser is baked in: containers reach the internet only through the
# egress proxy, which does not allow Playwright's download hosts.
FROM nakara-agent
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_MCP_BROWSER=chromium
RUN npm install -g @playwright/cli@0.1.8 \
 && node "$(npm root -g)/@playwright/cli/node_modules/playwright/cli.js" install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm
