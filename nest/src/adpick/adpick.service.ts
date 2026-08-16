import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { AppConfig, CONFIG, adpickApiEnabled } from '../config/configuration';

/**
 * 애드픽 커미션 링크 생성 API 클라이언트.
 *
 *   GET https://biz.adpick.co.kr/api/{apikey}/link?url={상품URL}&linkonly=true&p_data={코드}
 *
 *   {"success": true, "data": {"status": "success",
 *    "commissionlink": "https://link.adpick.co.kr/xxxxxxxx"}}
 *
 * 주의할 스펙 3가지
 *   1. **Rate limit**: linkonly=true 분당 60회 / linkonly=false 분당 10회 (API 키 기준).
 *      호텔 5건이면 캐시 미스 시 요청 1건에 5회를 쓴다. 캐시가 필수인 이유.
 *   2. **180일간 클릭 없는 링크는 삭제될 수 있다.** 그래서 노출마다 새 링크를 만들지 않고
 *      sourceUrl 단위로 하나를 만들어 재사용한다.
 *   3. **p_data 는 링크 생성 시점에 박힌다.** 클릭 단위로 바꿀 수 없으므로
 *      sourceUrl 단위 고정 코드를 쓴다.
 *      사용자별/클릭별 추적은 recommendation_items(노출 + click_count)가 담당한다.
 */

export const STATUS_OK = 'ok';
export const STATUS_FAILED = 'failed';
export const STATUS_FALLBACK = 'fallback';

const P_DATA_MAX = 50; // 애드픽 스펙: string(50)

export interface LinkResult {
  sourceUrl: string;
  affiliateUrl: string | null;
  status: string;
  pData?: string | null;
  merchantName?: string | null;
  commissionPer?: number | null;
  error?: string | null;
  raw?: Record<string, unknown> | null;
}

export const linkOk = (r: LinkResult): boolean =>
  (r.status === STATUS_OK || r.status === STATUS_FALLBACK) && Boolean(r.affiliateUrl);

/**
 * sourceUrl 하나당 고정되는 추적 코드.
 *
 * 애드픽 성과 데이터 API 의 구분 코드와 우리 affiliate_links 행을 조인하는 키.
 * 링크를 캐시해서 재사용하므로 클릭마다 다르게 만들 수는 없다.
 */
export function pDataFor(sourceUrl: string): string {
  const digest = createHash('sha1').update(sourceUrl, 'utf8').digest('hex').slice(0, 15);
  return `h_${digest}`.slice(0, P_DATA_MAX);
}

/** API 미설정 시 쓰는 폴백 템플릿. {source_url} / {click_id} 치환. */
export function renderTemplate(template: string, sourceUrl: string, clickId = ''): string {
  return template
    .split('{source_url}')
    .join(encodeURIComponent(sourceUrl))
    .split('{click_id}')
    .join(clickId);
}

/**
 * 최종 링크에 clickId 를 쿼리 파라미터로 붙인다.
 *
 * ⚠️ 애드픽 커미션 링크(link.adpick.co.kr/xxxxxxxx)는 이런 파라미터를 해석하지 않는다.
 * 애드픽 쪽 추적은 p_data 가 담당한다. 그래서 ADPICK_SUBID_PARAM 기본값은 비어 있고,
 * 이 함수는 다른 제휴사를 붙이거나 자체 랜딩을 쓸 때를 위해 남겨둔 것이다.
 */
export function applySubid(url: string, clickId: string, config: AppConfig): string {
  const param = (config.adpickSubidParam ?? '').trim();
  if (!url || !param || url.includes(`${param}=`)) return url;

  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(param)) parsed.searchParams.set(param, clickId);
    return parsed.toString();
  } catch {
    return url;
  }
}

@Injectable()
export class AdpickService {
  private readonly logger = new Logger(AdpickService.name);
  /** rate limit(분당 60회) 대비. 동시 호출을 묶어서 버스트를 줄인다. */
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private get endpoint(): string {
    const base = this.config.adpickApiBase.replace(/\/+$/, '');
    return `${base}/api/${this.config.adpickApiKey}/link`;
  }

  private async acquire(): Promise<void> {
    const max = Math.max(1, this.config.adpickMaxConcurrency);
    if (this.inFlight < max) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight += 1;
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  async convert(sourceUrl: string, merchant?: string | null): Promise<LinkResult> {
    if (!sourceUrl) {
      return {
        sourceUrl,
        affiliateUrl: null,
        status: STATUS_FAILED,
        error: 'empty sourceUrl',
      };
    }

    if (!adpickApiEnabled(this.config)) return this.fallback(sourceUrl);

    const pData = pDataFor(sourceUrl);
    const url = new URL(this.endpoint);
    url.searchParams.set('url', sourceUrl);
    url.searchParams.set('p_data', pData);
    if (!this.config.adpickLinkonly) url.searchParams.set('linkonly', 'false');

    await this.acquire();
    try {
      const body = await this.request(url);
      return this.parse(body, sourceUrl, pData);
    } catch (err) {
      // ⚠️ 애드픽은 API 키가 URL 경로에 들어간다(/api/{apikey}/link).
      //    예외 메시지에는 요청 URL 이 그대로 담기므로,
      //    가리지 않으면 키가 로그와 affiliate_links.error 에 남는다.
      const reason = this.redact(String(err instanceof Error ? err.message : err));
      this.logger.warn(`adpick convert failed url=${sourceUrl} err=${reason}`);
      const result = this.fallback(sourceUrl);
      result.error = reason.slice(0, 500);
      result.pData = pData;
      return result;
    } finally {
      this.release();
    }
  }

  private async request(url: URL): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.adpickTimeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for url '${this.redact(url.toString())}'`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- 내부
  /** API 키를 가린다. 로그·DB·응답 어디로도 새면 안 된다. */
  private redact(text: string): string {
    const key = this.config.adpickApiKey;
    return key ? text.split(key).join('***') : text;
  }

  private parse(body: unknown, sourceUrl: string, pData: string): LinkResult {
    const raw = (body && typeof body === 'object' ? body : { raw: body }) as Record<
      string,
      unknown
    >;
    const data = (raw.data ?? null) as Record<string, unknown> | null;
    const link = data && typeof data === 'object' ? data.commissionlink : null;

    if (typeof link !== 'string' || !link.startsWith('http')) {
      const message = typeof raw.message === 'string' ? raw.message : null;
      this.logger.warn(
        `adpick response had no commissionlink: ${this.redact(JSON.stringify(raw)).slice(0, 200)}`,
      );
      const result = this.fallback(sourceUrl);
      result.error = this.redact(message ?? 'no commissionlink in response').slice(0, 500);
      result.raw = raw;
      result.pData = pData;
      return result;
    }

    return {
      sourceUrl,
      affiliateUrl: link,
      status: STATUS_OK,
      pData,
      merchantName: typeof data?.cp_name === 'string' ? data.cp_name : null,
      commissionPer: toNumber(data?.commission_per),
      raw,
    };
  }

  private fallback(sourceUrl: string): LinkResult {
    const template = (this.config.adpickLinkTemplate ?? '').trim();
    if (template) {
      return {
        sourceUrl,
        affiliateUrl: renderTemplate(template, sourceUrl),
        status: STATUS_FALLBACK,
      };
    }
    // 템플릿도 없으면 원본 주소를 그대로 쓴다. 수익화는 안 되지만 챗봇은 산다.
    return { sourceUrl, affiliateUrl: sourceUrl, status: STATUS_FALLBACK };
  }
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
