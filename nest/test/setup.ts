/**
 * 테스트는 DB 없는 no-op 모드로 고정한다.
 * 로컬 .env 가 있어도 실제 Supabase·애드픽을 타면 안 된다.
 */
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.PUBLIC_BASE_URL = 'http://testserver';
process.env.ADPICK_API_KEY = '';
process.env.ADPICK_LINK_TEMPLATE = 'https://adpick.test/click/AB12?url={source_url}';
process.env.ADPICK_SUBID_PARAM = '';
process.env.KAKAO_SKILL_TOKEN = '';
process.env.SEARCH_CACHE_TTL_MINUTES = '60';
