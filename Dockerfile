FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

COPY scripts/package.json scripts/package-lock.json ./scripts/
RUN cd scripts && npm ci --omit=dev

COPY . .

RUN mkdir -p logs data

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node scripts/run-digest.js healthcheck

CMD ["node", "scripts/run-digest.js", "once"]
