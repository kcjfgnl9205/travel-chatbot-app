/**
 * 테이블 행 타입. **DB 에서 읽은 그대로의 모양**이다 (snake_case).
 *
 * 스키마는 db/mysql/*.sql 이 정한다. 컬럼을 추가·삭제하면 여기도 고친다 —
 * `select<UserRow>(...)` 로 받으면 컬럼 이름을 틀렸을 때 컴파일러가 잡는다.
 *
 * 값의 모양은 mysql.service.ts 의 typeCast 가 정한다:
 *   DATETIME → ISO 문자열(`...Z`) · DECIMAL → number · BOOLEAN → boolean · JSON → 파싱된 값.
 *   BIGINT 는 number 다 (id 가 2^53 을 넘을 일이 없다).
 */

/** ISO-8601 UTC 문자열 (`2026-11-03T12:00:00.000Z`). */
export type DbTime = string;

export interface UserRow {
  id: string;
  kakao_user_key: string;
  first_seen_at: DbTime;
  last_seen_at: DbTime;
  message_count: number;
}

export interface MessageRow {
  id: string;
  user_id: string | null;
  domain: string;
  block_name: string | null;
  utterance: string;
  parsed_city: string | null;
  params: Record<string, unknown>;
  raw_payload: unknown;
  created_at: DbTime;
}

export interface AffiliateLinkRow {
  id: string;
  partner: string;
  merchant: string | null;
  source_url: string;
  affiliate_url: string | null;
  p_data: string | null;
  merchant_name: string | null;
  commission_per: number | null;
  status: string;
  error: string | null;
  raw_response: unknown;
  converted_at: DbTime | null;
  expires_at: DbTime | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface RecommendationRow {
  id: string;
  user_id: string | null;
  message_id: string | null;
  domain: string;
  city_slug: string | null;
  guests: number | null;
  provider: string;
  item_count: number;
  cache_hit: boolean;
  latency_ms: number | null;
  created_at: DbTime;
}

export interface RecommendationItemRow {
  id: string;
  recommendation_id: string;
  domain: 'hotel' | 'flight' | 'attraction' | null;
  position: number;
  click_id: string;
  item_name: string;
  source_url: string | null;
  target_url: string;
  price: number | null;
  merchant: string | null;
  image_url: string | null;
  affiliate_link_id: string | null;
  click_count: number;
  first_clicked_at: DbTime | null;
  last_clicked_at: DbTime | null;
  created_at: DbTime;
}

export interface PlaceRow {
  id: number;
  canonical_name: string;
  slug: string;
  country_code: string | null;
  kind: 'country' | 'city' | 'area' | 'landmark';
  iata: string | null;
  parent_id: number | null;
  rank: number | null;
  blurb: string | null;
  created_at: DbTime;
}

export interface PlaceAliasRow {
  alias: string;
  place_id: number;
  created_at: DbTime;
}

export interface SearchResultRow {
  cache_key: string;
  kind: 'hotel' | 'flight' | 'attraction';
  place_id: number | null;
  from_place_id: number | null;
  to_place_id: number | null;
  trip_type: 'rt' | 'ow' | null;
  status: 'pending' | 'ready' | 'failed';
  items: unknown[];
  item_count: number;
  meta: Record<string, unknown>;
  error: string | null;
  fetched_at: DbTime | null;
  expires_at: DbTime | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface IntentCacheRow {
  utterance_hash: string;
  result: unknown;
  created_at: DbTime;
  expires_at: DbTime;
}

export interface AttractionRow {
  id: number;
  city_id: number;
  name: string;
  name_en: string | null;
  area: string | null;
  image_url: string | null;
  image_source: string | null;
  rank: number;
  source: 'manual' | 'ai';
  impression_count: number;
  click_count: number;
  first_clicked_at: DbTime | null;
  last_clicked_at: DbTime | null;
  created_at: DbTime;
  updated_at: DbTime;
}
