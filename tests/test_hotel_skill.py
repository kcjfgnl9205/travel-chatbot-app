from app.db import memory_store
from app.kakao import templates as t
from tests.conftest import kakao_payload

ENDPOINT = "/api/v1/kakao/hotels/recommend"


def _list_card(body: dict) -> dict:
    return next(o["listCard"] for o in body["template"]["outputs"] if "listCard" in o)


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_osaka_returns_list_card(client):
    res = client.post(ENDPOINT, json=kakao_payload("오사카 호텔 추천해줘"))
    assert res.status_code == 200
    body = res.json()

    assert body["version"] == "2.0"
    assert len(body["template"]["outputs"]) == 1  # 캐러셀 없이 listCard 하나

    card = _list_card(body)
    assert "오사카" in card["header"]["title"]
    assert len(card["items"]) == 5

    row = card["items"][0]
    assert row["title"]
    assert row["description"].startswith("1박 ")
    assert row["imageUrl"].startswith("https://")
    # 줄 전체 링크가 애드픽이 아니라 우리 리다이렉트를 가리켜야 클릭 추적이 된다
    assert "/r/" in row["link"]["web"]


def test_list_card_respects_kakao_limits(client):
    res = client.post(ENDPOINT, json=kakao_payload("도쿄 호텔 추천해줘"))
    card = _list_card(res.json())

    assert len(card["header"]["title"]) <= t.MAX_LIST_HEADER_TITLE
    assert 1 <= len(card["items"]) <= t.MAX_LIST_ITEMS
    assert len(card.get("buttons", [])) <= t.MAX_LIST_BUTTONS
    for row in card["items"]:
        assert len(row["title"]) <= t.MAX_LIST_ITEM_TITLE
        assert len(row["description"]) <= t.MAX_LIST_ITEM_DESC
    for button in card.get("buttons", []):
        assert len(button["label"]) <= t.MAX_BUTTON_LABEL


def test_every_row_gets_its_own_click_id(client):
    """호텔마다 click_id 가 달라야 어떤 줄을 눌렀는지 구분된다."""
    card = _list_card(client.post(ENDPOINT, json=kakao_payload("오사카 호텔")).json())
    click_ids = [row["link"]["web"].rsplit("/r/", 1)[1] for row in card["items"]]
    assert len(set(click_ids)) == len(click_ids)


def test_city_param_takes_priority_over_utterance(client):
    res = client.post(ENDPOINT, json=kakao_payload("호텔 추천해줘", city="후쿠오카"))
    assert "후쿠오카" in _list_card(res.json())["header"]["title"]


def test_missing_city_asks_back(client):
    res = client.post(ENDPOINT, json=kakao_payload("호텔 추천해줘"))
    body = res.json()
    assert "어느 도시" in body["template"]["outputs"][0]["simpleText"]["text"]
    assert len(body["template"]["quickReplies"]) == 3


def test_unknown_city_falls_back_to_ask(client):
    res = client.post(ENDPOINT, json=kakao_payload("파리 호텔 추천해줘"))
    assert "어느 도시" in res.json()["template"]["outputs"][0]["simpleText"]["text"]


def test_other_city_button_reaches_ask_flow(client):
    """카드 버튼의 messageText 가 실제로 되묻기 응답을 만들어야 한다."""
    card = _list_card(client.post(ENDPOINT, json=kakao_payload("오사카 호텔")).json())
    message_text = card["buttons"][0]["messageText"]

    res = client.post(ENDPOINT, json=kakao_payload(message_text))
    assert "어느 도시" in res.json()["template"]["outputs"][0]["simpleText"]["text"]


def test_click_redirects_and_is_tracked(client):
    res = client.post(ENDPOINT, json=kakao_payload("오사카 호텔 추천해줘"))
    url = _list_card(res.json())["items"][0]["link"]["web"]
    click_id = url.rsplit("/r/", 1)[1]

    redirected = client.get(f"/r/{click_id}", follow_redirects=False)
    assert redirected.status_code == 302
    location = redirected.headers["location"]
    # 사용자에게는 제휴 주소만 노출된다. 원본 호텔 주소가 그대로 나가면 안 된다.
    assert location.startswith("https://adpick.test/click/AB12")
    # 원본 주소는 제휴 링크 안에 인코딩되어 실린다
    assert "example.com%2Fagoda%2Fhotel" in location


def test_repeated_clicks_increment_counter(client):
    """같은 줄을 여러 번 눌러도 행이 쌓이지 않고 카운터만 올라간다."""
    res = client.post(ENDPOINT, json=kakao_payload("오사카 호텔 추천해줘"))
    click_id = _list_card(res.json())["items"][0]["link"]["web"].rsplit("/r/", 1)[1]

    for _ in range(3):
        assert client.get(f"/r/{click_id}", follow_redirects=False).status_code == 302

    assert memory_store.get(click_id)["click_count"] == 3


def test_unknown_click_id_returns_404(client):
    assert client.get("/r/nope", follow_redirects=False).status_code == 404


def test_fallback_block(client):
    res = client.post("/api/v1/kakao/fallback", json=kakao_payload("안녕"))
    assert res.status_code == 200
    assert res.json()["template"]["quickReplies"]
