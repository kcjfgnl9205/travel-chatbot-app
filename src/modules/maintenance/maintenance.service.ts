import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AppConfig, CONFIG } from '../../config/app.config';
import { MemoryStoreService } from '../database/memory-store.service';
import { MaintenanceRepository } from '../database/repositories/maintenance.repository';
import { UsersRepository } from '../database/repositories/users.repository';
import { IntentService } from '../intent/intent.service';
import { SearchService } from '../search/search.service';

/**
 * **비우는 것 — 행동 로그와 캐시뿐이다.** 자식이 앞에 온다(FK 를 꺼도 읽기 좋게).
 *
 * | 테이블 | 비우면 |
 * |---|---|
 * | `recommendation_items` | 이미 나간 카드의 `/r/{click_id}` 가 "링크가 만료되었어요" 로 간다 |
 * | `recommendations` · `messages` · `users` | 과거 CTR·발화 지표가 사라진다. 동작에는 영향 없다 |
 * | `affiliate_links` | 애드픽 변환 캐시. 다시 쌓는 데 **분당 60회 제한**이 걸린다 |
 * | `search_results` | 검색 캐시(호텔 24h·항공 6h·관광 1h). 첫 질문들이 한 번 느려진다 |
 * | `intent_cache` | 발화 해석 캐시(7일). 같은 문장을 한 번 더 모델에 묻는다 |
 */
export const CLEARED_TABLES = [
  'recommendation_items',
  'recommendations',
  'messages',
  'users',
  'affiliate_links',
  'search_results',
  'intent_cache',
] as const;

/**
 * **건드리지 않는 것.** 세는 이유는 안심시키기 위해서다 — 비운 직후 응답에
 * "관광지 2,287행은 그대로" 가 같이 찍힌다.
 *
 * ⚠️ **`attractions` 를 이 API 로 비울 수 있게 만들지 않았다.** 이 서비스에서 유일하게
 *    사람 손이 들어간 데이터이고([docs/attraction-seed](../../../docs/attraction-seed/README.md)),
 *    `TRUNCATE` 로 비우면 `auto_increment` 가 1 로 돌아가 **이미 나간 관광지 카드의
 *    `/a/{id}` 가 엉뚱한 곳으로 열린다** ([redirect.controller.ts] 의 `a/:id`).
 *    정말 지워야 한다면 백업을 뜬 뒤 손으로 할 일이지, 토큰 하나로 될 일이 아니다.
 *
 * ⚠️ `schema_migrations` 도 없다. 지우면 다음 배포가 0001 부터 다시 돈다.
 */
export const PRESERVED_TABLES = ['places', 'place_aliases', 'attractions'] as const;

export interface ResetPreview {
  /** `confirm` 에 적어야 하는 값. `MYSQL_DATABASE` 다. */
  database: string;
  /** 비울 테이블의 현재 행 수. */
  clears: Record<string, number>;
  /** 그대로 두는 테이블의 현재 행 수. */
  preserves: Record<string, number>;
  /** `clears` 의 합. */
  total: number;
}

export interface ResetResult extends ResetPreview {
  /** 실제로 지운 행 수(= 비우기 직전에 센 값). */
  cleared: Record<string, number>;
  /** 프로세스 안의 캐시도 비웠나. 항상 true — 안 비우면 DB 와 어긋난다. */
  memoryCleared: boolean;
  elapsedMs: number;
}

/**
 * 서비스 데이터 초기화.
 *
 * **행동 로그와 캐시만 비운다.** 지역(`places`)과 관광지(`attractions`)는 남긴다 —
 * 그 둘은 "쌓인 것" 이 아니라 "만든 것" 이라서, 비우고 다시 시작한다는 말에 포함되지
 * 않는다. 무엇을 남기고 무엇을 비우는지는 {@link CLEARED_TABLES} 와
 * {@link PRESERVED_TABLES} 에 적혀 있다.
 *
 * ⚠️ **DB 만 비우면 안 된다.** 프로세스 안에 DB 를 거울처럼 들고 있는 캐시가 넷 있고,
 *    그중 하나는 비우지 않으면 **다음 요청부터 기록이 통째로 빈다** —
 *    [UsersRepository](../database/repositories/users.repository.ts) 가
 *    `kakao_user_key → users 행` 을 들고 있어서, `users` 를 비운 뒤에도 사라진
 *    `user_id` 를 계속 돌려준다. 그 값으로 `messages` 를 넣으면 FK 위반이고,
 *    레포지토리는 예외 대신 null 을 돌려주므로 **아무도 모르게** 로그만 안 쌓인다.
 *
 * ⚠️ **캐시는 이 프로세스 것만 비운다.** 앱을 여러 벌 띄우면 나머지 프로세스의
 *    캐시는 그대로다. 지금은 컨테이너 하나라(docker compose 의 `app`) 문제가 없지만,
 *    늘리는 날에는 비운 뒤 재시작이 함께 필요하다.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly maintenance: MaintenanceRepository,
    private readonly users: UsersRepository,
    private readonly clicks: MemoryStoreService,
    private readonly search: SearchService,
    private readonly intent: IntentService,
  ) {}

  /** 지워질 행 수를 미리 센다. **아무것도 지우지 않는다.** */
  async preview(): Promise<ResetPreview> {
    const counts = await this.countAll();
    return this.toPreview(counts);
  }

  /**
   * 로그와 캐시를 비운다.
   *
   * 순서가 둘이고, 둘 다 뒤집으면 틀린다.
   *
   * 1. **세고 나서 비운다.** TRUNCATE 는 지운 행 수를 돌려주지 않는다
   *    (DELETE 와 달리 행을 하나씩 건드리지 않는다). 미리 세지 않으면 영영 모른다.
   * 2. **DB 를 비우고 나서 메모리를 비운다.** 반대로 하면 비우는 동안 들어온 요청이
   *    곧 사라질 행을 캐시에 다시 넣고, 그게 그대로 남는다.
   */
  async reset(): Promise<ResetResult> {
    const startedAt = Date.now();
    const counts = await this.countAll();
    const before = this.toPreview(counts);

    const outcome = await this.maintenance.truncate(CLEARED_TABLES);
    if (!outcome) throw dbOff();

    this.clearMemory();

    if (outcome.failed) {
      // 일부만 비워진 상태다. **되돌릴 수 없으므로** 어디까지 갔는지 그대로 올린다 —
      // 다시 부르면 남은 테이블부터 이어진다(이미 빈 테이블을 또 비울 뿐이다).
      throw new InternalServerErrorException({
        message: '일부만 비웠다. 같은 요청을 다시 보내면 이어서 비운다',
        cleared: pick(before.clears, outcome.cleared),
        failed: outcome.failed,
      });
    }

    const elapsedMs = Date.now() - startedAt;
    this.logger.warn(
      `reset cleared=${before.total} rows tables=${outcome.cleared.length} in ${elapsedMs}ms`,
    );
    return {
      ...before,
      // 비운 뒤라 전부 0 이다. 지운 수는 `cleared` 에 있다.
      clears: Object.fromEntries(Object.keys(before.clears).map((t) => [t, 0])),
      total: 0,
      cleared: before.clears,
      memoryCleared: true,
      elapsedMs,
    };
  }

  /**
   * DB 를 거울처럼 들고 있는 프로세스 안의 캐시를 비운다.
   *
   * `places` 쪽 캐시(PlacesService)는 일부러 두지 않았다 — `places`·`place_aliases` 를
   * 비우지 않으므로 캐시도 맞는 값을 들고 있다.
   */
  private clearMemory(): void {
    this.users.clearMemory(); // users 를 비웠다. 안 지우면 없는 user_id 를 계속 쓴다
    this.clicks.clear(); // recommendation_items 를 비웠다. /r 이 메모리를 먼저 본다
    this.search.clearMemory(); // search_results + "더 보기" 커서
    this.intent.clearMemory(); // intent_cache
  }

  private async countAll(): Promise<Record<string, number>> {
    if (!this.maintenance.available) throw dbOff();
    const counts = await this.maintenance.countRows([...CLEARED_TABLES, ...PRESERVED_TABLES]);
    // ⚠️ 레포지토리는 실패해도 예외 대신 null 을 돌려준다(챗봇 응답을 죽이지 않으려고).
    //    여기서는 그 규칙을 뒤집어 올린다 — **못 셌는데 비우기로 넘어가면 안 된다.**
    if (!counts) throw dbOff();
    return counts;
  }

  private toPreview(counts: Record<string, number>): ResetPreview {
    const clears = pick(counts, CLEARED_TABLES);
    return {
      database: this.config.mysqlDatabase,
      clears,
      preserves: pick(counts, PRESERVED_TABLES),
      total: Object.values(clears).reduce((sum, n) => sum + n, 0),
    };
  }
}

/** 주어진 테이블만 순서대로 추린다. */
function pick(counts: Record<string, number>, tables: readonly string[]): Record<string, number> {
  return Object.fromEntries(tables.map((t) => [t, counts[t] ?? 0]));
}

/**
 * ⚠️ **DB 가 없으면 성공한 척하지 않는다.** 레포지토리는 DB 가 꺼져 있을 때 null 을
 *    돌려주고 앱은 그대로 돈다 — 챗봇에는 맞는 설계지만, 여기서 그대로 따르면
 *    "0행 지웠다" 는 성공 응답이 나가고 운영은 다 지워진 줄 안다.
 */
const dbOff = (): ServiceUnavailableException =>
  new ServiceUnavailableException('DB 에 접속할 수 없다. MYSQL_* 자격증명을 확인한다');
