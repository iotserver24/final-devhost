# Nexathon's minimal coding sandbox. Adapted from the sibling
# supercharge/sandbox/e2b-agent-template Dockerfile and betacsinmamit/e2b-template.
# Unlike the interactive Vectra image, this has no daemon, browser, VNC, or bundled secrets.
FROM e2bdev/base:latest

# Supercharge 1.4.22 links libdbus. The slim base image does not ship it.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

USER user
WORKDIR /home/user

# Keep install sources, version pins, and image build recipe in Git. No binaries or keys.
RUN curl -fsSL https://bun.com/install -o /tmp/nexathon-bun-install.sh \
    && bash /tmp/nexathon-bun-install.sh bun-v1.3.11 \
    && rm -f /tmp/nexathon-bun-install.sh

RUN curl -fsSL https://raw.githubusercontent.com/supercharge-cli/supercharge-releases/main/scripts/install.sh -o /tmp/nexathon-supercharge-install.sh \
    && SUPERCHARGE_VERSION=1.4.22 \
       SUPERCHARGE_GITHUB_REPO=supercharge-cli/supercharge-releases \
       SUPERCHARGE_NO_MODIFY_PATH=1 \
       bash /tmp/nexathon-supercharge-install.sh \
    && rm -f /tmp/nexathon-supercharge-install.sh

ENV PATH=/home/user/.bun/bin:/home/user/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN /home/user/.bun/bin/bun --version && /home/user/.local/bin/supercharge --version && git --version
