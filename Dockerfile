# 빌드 스테이지
FROM node:24-slim AS build
WORKDIR /build

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY test ./test
# ⚠️ **테스트가 이 파일을 읽는다.** env-example.spec.ts 가 "코드가 읽는 환경변수 ==
#    .env.example" 을 검사하므로, 빠뜨리면 로컬 `npm test` 는 통과하는데 도커 빌드만
#    깨진다 — 실제로 그 상태로 배포가 한 번 막혔다.
#    실값 .env 는 절대 복사하지 않는다. 시크릿은 런타임에 env_file 로만 들어온다.
COPY .env.example ./

# 테스트를 빌드 게이트로 쓴다.
#
# GitHub Actions 를 걷어냈으므로 깨진 커밋을 막을 곳이 여기밖에 없다.
# 실패하면 이미지가 안 만들어지고 `docker compose up` 도 실패하므로,
# **돌고 있던 컨테이너는 그대로 살아 있다.** 배포가 안 될 뿐 서비스는 안 죽는다.
RUN npx tsc --noEmit && npx jest --ci

RUN npx nest build && npm prune --omit=dev

# 실행 스테이지
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist

# 루트로 돌리지 않는다. 컨테이너가 뚫려도 권한을 제한한다.
RUN useradd --system --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main"]
