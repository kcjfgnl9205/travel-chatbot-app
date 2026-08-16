# 빌드 스테이지
FROM node:22-slim AS build
WORKDIR /build

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npx nest build && npm prune --omit=dev

# 실행 스테이지
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
# static provider 가 읽는 고정 데이터.
COPY data ./data

# 루트로 돌리지 않는다. 컨테이너가 뚫려도 권한을 제한한다.
RUN useradd --system --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main"]
