from tests.conftest import kakao_payload

ENDPOINT = "/api/v1/kakao/hotels/recommend"


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_osaka_returns_carousel(client):
    res = client.post(ENDPOINT, json=kakao_payload("오사카 호텔 추천해줘"))
    assert res.status_code == 200
    body = res.json()

    assert body["version"] == "2.0"
    outputs = body["template"]["outputs"]
    carousel = next(o["carousel"] for o in outputs if "carousel" in o)
    assert carousel["type"] == "basicCard"
    assert len(carousel["items"]) == 5

    card = carousel["items"][0]
    assert card["title"]
    assert card["thumbnail"]["imageUrl"].startswith("https://")
    # 애드픽 링크가 아니라 우리 리다이렉트를 가리켜야 클릭 추적이 된다
    assert "/r/" in card["buttons"][0]["webLinkUrl"]


def test_city_param_takes_priority_over_utterance(client):
    res = client.post(ENDPOINT, json=kakao_payload("호텔 추천해줘", city="후쿠오카"))
    header = res.json()["template"]["outputs"][0]["simpleText"]["text"]
    assert "후쿠오카" in header


def test_missing_city_asks_back(client):
    res = client.post(ENDPOINT, json=kakao_payload("호텔 추천해줘"))
    body = res.json()
    assert "어느 도시" in body["template"]["outputs"][0]["simpleText"]["text"]
    assert len(body["template"]["quickReplies"]) == 3


def test_unknown_city_falls_back_to_ask(client):
    res = client.post(ENDPOINT, json=kakao_payload("파리 호텔 추천해줘"))
    assert "어느 도시" in res.json()["template"]["outputs"][0]["simpleText"]["text"]


def test_card_limits_are_respected(client):
    res = client.post(ENDPOINT, json=kakao_payload("도쿄 호텔 추천해줘"))
    carousel = res.json()["template"]["outputs"][1]["carousel"]
    for card in carousel["items"]:
        assert len(card["title"]) <= 40
        assert len(card["description"]) <= 76
        assert len(card["buttons"][0]["label"]) <= 14


def test_click_redirects_and_is_tracked(client):
    res = client.post(ENDPOINT, json=kakao_payload("오사카 호텔 추천해줘"))
    url = res.json()["template"]["outputs"][1]["carousel"]["items"][0]["buttons"][0][
        "webLinkUrl"
    ]
    click_id = url.rsplit("/r/", 1)[1]

    redirected = client.get(f"/r/{click_id}", follow_redirects=False)
    assert redirected.status_code == 302
    location = redirected.headers["location"]
    assert location.startswith("https://example.com/adpick/")
    # click_id 가 subid 로 실려야 나중에 전환 매칭이 된다
    assert f"subid={click_id}" in location


def test_unknown_click_id_returns_404(client):
    assert client.get("/r/nope", follow_redirects=False).status_code == 404


def test_fallback_block(client):
    res = client.post("/api/v1/kakao/fallback", json=kakao_payload("안녕"))
    assert res.status_code == 200
    assert res.json()["template"]["quickReplies"]
