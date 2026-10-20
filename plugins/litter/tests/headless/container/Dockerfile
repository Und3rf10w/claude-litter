# Tier 4's managed-settings runs (plan section 12): a Linux box whose
# /etc/claude-code the runs may write, so cc-plugin-sec-default is seated and
# the managed policies apply. Built and run by container.sh.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*
# A version or a range, as CI's: 2.1.288 is the first with the worker-hop fix.
ARG CC_VERSION=>=2.1.288
RUN npm install -g "@anthropic-ai/claude-code@${CC_VERSION}"
RUN useradd -m tester && mkdir -p /etc/claude-code && chown tester /etc/claude-code
USER tester
WORKDIR /home/tester
# A person's machine has a git identity; run.start refuses without one.
RUN git config --global user.name tier4 && git config --global user.email tier4@example.invalid
ENV LITTER_TIER4_CONTAINER=1
