FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/.data && chown -R node:node /app
USER node
EXPOSE 4318
CMD ["node", "src/server.mjs"]
