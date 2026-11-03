/**
 * 테스트는 DB 없는 no-op 모드로 고정한다.
 * 로컬 .env 가 있어도 실제 MySQL·애드픽을 타면 안 된다.
 */
process.env.MYSQL_HOST = '';
process.env.PUBLIC_BASE_URL = 'http://testserver';
process.env.ADPICK_API_KEY = '';
process.env.ADPICK_LINK_TEMPLATE = 'https://adpick.test/click/AB12?url={source_url}';
process.env.ADPICK_SUBID_PARAM = '';
process.env.KAKAO_SKILL_TOKEN = '';
