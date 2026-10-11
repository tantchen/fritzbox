# Development container only, the package itself is plain JavaScript on npm.
#   docker compose up -d && docker compose exec dev npm test
FROM node:24-alpine
WORKDIR /home/node/pkg
# node_modules is a named volume (see compose.yaml); creating the directory here makes the
# fresh volume belong to the node user instead of root
RUN mkdir -p /home/node/pkg/node_modules && chown -R node:node /home/node/pkg
USER node
CMD ["sleep", "infinity"]
