FROM node:22-slim

# System deps
RUN apt-get update && apt-get install -y \
    git curl jq gosu unzip procps python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Non-root user (claude --dangerously-skip-permissions refuses root)
RUN useradd -m -s /bin/bash agent \
    && mkdir -p /workspace \
    && chown agent:agent /workspace

# Claude Code CLI (native installer — as agent user)
RUN gosu agent bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
ENV PATH="/home/agent/.local/bin:$PATH"

# Aider CLI (installed in venv as agent user)
RUN gosu agent python3 -m venv /home/agent/.aider-venv \
    && gosu agent /home/agent/.aider-venv/bin/pip install aider-chat
ENV PATH="/home/agent/.aider-venv/bin:$PATH"

# Deno (installed as root, available to all users)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
ENV DENO_INSTALL="/usr/local"

WORKDIR /workspace

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
