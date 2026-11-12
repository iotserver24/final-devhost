# Nexathon's minimal coding sandbox. Adapted from the sibling
# supercharge/sandbox/e2b-agent-template Dockerfile and betacsinmamit/e2b-template.
# Unlike the interactive Vectra image, this has no daemon, browser, VNC, or bundled secrets.
FROM e2bdev/base:latest

USER user
WORKDIR /home/user

# Keep install sources, version pins, and image build recipe in Git. No binaries or keys.
RUN curl -fsSL https://bun.com/install -o /tmp/nexathon-bun-install.sh \
    && bash /tmp/nexathon-bun-install.sh bun-v1.3.11 \
    && rm -f /tmp/nexathon-bun-install.sh

RUN curl -fsSL https://www.superchargeai.in/install.sh -o /tmp/nexathon-supercharge-install.sh \
    && SUPERCHARGE_VERSION=1.3.30 \
       SUPERCHARGE_GITHUB_REPO=iotserver24/supercharge-releases \
       SUPERCHARGE_NO_MODIFY_PATH=1 \
       bash /tmp/nexathon-supercharge-install.sh \
    && rm -f /tmp/nexathon-supercharge-install.sh

ENV PATH=/home/user/.bun/bin:/home/user/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN /home/user/.bun/bin/bun --version && /home/user/.local/bin/supercharge --version && git --version
