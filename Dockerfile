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
# ⚠️ **테스트가 이 파일들도 읽는다.** rls.spec.ts 는 "새 테이블에 RLS 가 켜졌나" 를,
#    item-detail-columns.spec.ts 는 "코드가 쓰는 컬럼이 마이그레이션에 있나" 를
#    SQL 파일과 직접 대조한다. 둘 다 타입 검사도 린트도 못 잡는 종류의 사고라
#    테스트로 막는 것이고, 그러려면 이미지 안에 파일이 있어야 한다.
COPY supabase/migrations ./supabase/migrations
# ⚠️ **이 파일도 테스트가 읽는다.** nginx-fallback.spec.ts 가 "앱이 죽었을 때 nginx 가
#    돌려줄 말풍선" 이 유효한 카카오 응답인지 검사한다. 평소 안 타는 경로라 깨져도
#    아무도 모르는 종류의 사고라서 테스트로 묶었고, 그러려면 이미지 안에 있어야 한다.
COPY deploy/nginx ./deploy/nginx

# 테스트를 빌드 게이트로 쓴다.
#
# 깨진 커밋이 들어와도 이미지가 안 만들어지고 `docker compose up` 이 실패하므로,
# **돌고 있던 컨테이너는 그대로 살아 있다.** 배포가 안 될 뿐 서비스는 안 죽는다.
# 서버에서 손으로 배포할 때 이게 유일한 그물이라 기본값은 '돈다' 이다.
#
# ⚠️ **CI 경로에서는 끈다 (SKIP_TESTS=1).** 워크플로의 deploy 잡은 `needs: test` 라
#    이미 같은 린트·타입체크·테스트를 통과한 커밋만 여기 온다. 느린 서버에서 한 번
#    더 돌리면 SSH 명령이 10분 제한에 걸려 **배포가 통째로 끊긴다** — 실제로 그랬다.
ARG SKIP_TESTS=0
RUN if [ "$SKIP_TESTS" = "1" ]; then \
        echo "▸ 테스트 생략 (SKIP_TESTS=1) — CI 가 이미 돌렸다"; \
    else \
        npx tsc --noEmit && npx jest --ci; \
    fi

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
