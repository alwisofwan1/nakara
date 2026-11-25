# Image for the Docker runner: build with
#   docker build -t nakara-agent -f deploy/agent.Dockerfile deploy
# The claude binary is not baked in; Nakara mounts the host's read-only.
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git gh ripgrep ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 # Push over HTTPS with GH_TOKEN, even for remotes cloned as git@github.com.
 && git config --system url."https://github.com/".insteadOf "git@github.com:" \
 && git config --system credential."https://github.com".helper '!gh auth git-credential' \
 && git config --system --add safe.directory '*'
