# The sandbox an agent works in when the factory runs on this machine instead of Vercel Sandbox: Node, git,
# the build tools, and bubblewrap and strace for the projects whose tests need them. It has no network of its own:
# everything goes through the egress proxy of its sandbox (see docker-sandbox.ts), which a child process reaches
# by the network itself (a default route and a resolver that point at the proxy), not by the environment.
FROM node:22-bookworm
# `node` is a wrapper that makes Node trust the proxy's certificate when the environment that started it was
# dropped (Node reads only its own roots and NODE_EXTRA_CA_CERTS), so a test that starts a child with only
# PATH and HOME still fetches over https. `iproute2` and `iptables` are for the network steps of the provider,
# which run in a helper container and never leave anything in the sandbox.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap iproute2 iptables jq strace unzip \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && mkdir -p /work /cache \
 && mv /usr/local/bin/node /usr/local/bin/node-real \
 && printf '%s\n' \
  '#!/bin/sh' \
  'if [ -z "$NODE_EXTRA_CA_CERTS" ] && [ -r /home/node/factory-ca-bundle.pem ]; then' \
  '  export NODE_EXTRA_CA_CERTS=/home/node/factory-ca-bundle.pem' \
  'fi' \
  'exec /usr/local/bin/node-real "$@"' > /usr/local/bin/node \
 && chmod 755 /usr/local/bin/node \
 && chown node:node /work /cache /usr/local/bin
# What a package manager downloads is kept in /cache, which a sandbox of the same repository shares. Corepack
# looks there through COREPACK_HOME, and under the home of the user when a child drops the environment: the
# link makes both the same directory, so the package manager a repository declares is fetched once for every
# child. The headers of Node are in /usr/local, so node-gyp never downloads them (nodejs.org is not allowed).
ENV NODE_USE_ENV_PROXY=1 CI=true COREPACK_HOME=/cache/corepack npm_config_nodedir=/usr/local
USER node
RUN echo 'store-dir=/cache/pnpm' > /home/node/.npmrc \
 && mkdir -p /home/node/.cache/node \
 && ln -s /cache/corepack /home/node/.cache/node/corepack
WORKDIR /work
CMD ["sleep", "infinity"]
