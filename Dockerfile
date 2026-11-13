FROM node:24-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node . .
RUN npx prisma generate && npm run build && mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production DATABASE_URL=file:/app/data/hub.db ASSET_DIR=/app/data/assets
USER node
EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push && exec npm run start -- --hostname 0.0.0.0"]
