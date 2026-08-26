from __future__ import annotations

import json
from textwrap import dedent

import httpx
import pytest
from bs4 import BeautifulSoup
from orbit_api.library.opac_gateway import (
    NCIP_FULL_PATH,
    NCIP_MULTI_PATH,
    OpacGateway,
    OpacGatewayError,
    _Page,
    _resource_ref,
)
from orbit_api.models import (
    ChatLibraryContextRecord,
    LibraryBibliographicRecord,
    LibraryHoldingSummary,
)


def settings_script(*, detail: bool = False, token: str = "a" * 32) -> str:
    if detail:
        value = {
            "xc_search": {
                "page": "node",
                "token": token,
                "node_id": 208838,
                "ncip_bibs": {"1": ["BD03194521"]},
                "ncip_url": f"https://library.shibaura-it.ac.jp{NCIP_FULL_PATH}",
            }
        }
    else:
        value = {
            "xc_search": {
                "token": token,
                "ncip_info": {"1": [{"208838": ["BD03194521"]}]},
                "multi_ncip_url": f"https://library.shibaura-it.ac.jp{NCIP_MULTI_PATH}",
                "ncip_id": "1",
            }
        }
    return f"<script>jQuery.extend(Drupal.settings, {json.dumps(value)});</script>"


def detail_html() -> str:
    return dedent(
        f"""
        <html><head>
          <meta name="title" content="大規模言語モデル入門 = Introduction to large language models">
          <meta name="author" content="山田育矢監修著 ; 鈴木正敏, 山田康輔, 李凌寒著">
          {settings_script(detail=True)}
        </head><body>
          <h3 class="node-title">大規模言語モデル入門 = Introduction to large language models</h3>
        </body></html>
        """
    )


def availability_html() -> str:
    return dedent(
        """
        <table id="detail_table"><thead><tr><td>状態 所在 請求記号</td></tr></thead>
        <tbody>
          <tr><td class="locBox"><div class="bkAva red"><dd>貸出中</dd></div>
            <div class="bkLoc"><dd>豊洲図書館　豊洲（拡張）図書</dd></div>
            <div class="bkCnu"><span class="spDisInl">007.13/Y19</span></div>
            <div class="bkDue"><dd>2026/10/02</dd></div>
          </td></tr>
          <tr><td class="locBox"><div class="bkAva"><dd>貸出可</dd></div>
            <div class="bkLoc"><dd>大宮図書館　2階書架(B)人文社会</dd></div>
            <div class="bkCnu"><span class="spDisInl">007.13/Y19</span></div>
          </td></tr>
        </tbody></table>
        """
    )


@pytest.mark.asyncio
async def test_gateway_parses_detail_rows_without_header_or_duplicate_holdings(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OPAC_TRANSPORT", "server")
    gateway = OpacGateway()
    # Exercise the same projection path used by the live full-NCIP response.
    holdings = gateway._holdings_from_availability(
        {"content": availability_html(), "status": 0, "count": 2}
    )
    assert len(holdings) == 2
    assert [item.campus for item in holdings] == ["toyosu", "omiya"]
    assert holdings[0].due_date == "2026-10-02"
    assert holdings[1].status == "available"


def test_resource_ref_matches_extension_hash_contract() -> None:
    assert _resource_ref("/opc/recordID/catalog.bib/BD03194521") == (
        "orbit-library://record/8935255aff1c5a9e"
    )


@pytest.mark.asyncio
async def test_zero_result_search_is_normal(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OPAC_TRANSPORT", "server")
    gateway = OpacGateway()
    html = '<div id="xc-search-no-result">一致する資料は見つかりませんでした。</div>'
    request = httpx.Request("GET", "https://library.shibaura-it.ac.jp/opc/xc/search/no-result")
    page = _Page(
        response=httpx.Response(
            200,
            request=request,
            headers={"content-type": "text/html"},
            content=html.encode(),
        ),
        soup=BeautifulSoup(html, "html.parser"),
        settings={},
        kind="search",
    )

    async def fake_get_page(_client, _url):
        return page

    monkeypatch.setattr(gateway, "_get_page", fake_get_page)
    result = await gateway.search(query="合成タイトル")
    assert result.status == "known"
    assert result.items == []
    assert result.reason_code is None


@pytest.mark.asyncio
async def test_single_record_redirect_is_a_normal_one_item_search(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OPAC_TRANSPORT", "server")
    monkeypatch.setenv("ORBIT_OPAC_MIN_INTERVAL_MS", "0")
    gateway = OpacGateway()
    url = "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/BD03194521?caller=xc-search"
    request = httpx.Request("GET", url)
    response = httpx.Response(
        200,
        request=request,
        headers={"content-type": "text/html"},
        content=detail_html().encode(),
    )
    page = _Page(
        response=response,
        soup=BeautifulSoup(detail_html(), "html.parser"),
        settings={
            "xc_search": {
                "token": "a" * 32,
                "ncip_bibs": {"1": ["BD03194521"]},
                "ncip_url": f"https://library.shibaura-it.ac.jp{NCIP_FULL_PATH}",
            }
        },
        kind="record",
    )

    async def fake_get_page(_client, _url):
        return page

    async def fake_availability(*_args, **_kwargs):
        return {"content": availability_html(), "status": 0, "count": 2}

    monkeypatch.setattr(gateway, "_get_page", fake_get_page)
    monkeypatch.setattr(gateway, "_availability", fake_availability)
    result = await gateway.search(query="一件だけの書誌")
    assert result.status == "known"
    assert len(result.items) == 1
    assert result.items[0].resource_ref == "orbit-library://record/8935255aff1c5a9e"
    assert len(result.items[0].holdings) == 2


@pytest.mark.asyncio
async def test_search_without_availability_contract_is_unavailable(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OPAC_TRANSPORT", "server")
    gateway = OpacGateway()
    html = dedent(
        """
        <div class="result-row">
          <div class="xc-title"><a href="/opc/recordID/catalog.bib/BD03194521">1. 書誌</a></div>
        </div>
        """
    )
    request = httpx.Request("GET", "https://library.shibaura-it.ac.jp/opc/xc/search/書誌")
    page = _Page(
        response=httpx.Response(200, request=request, headers={"content-type": "text/html"}),
        soup=BeautifulSoup(html, "html.parser"),
        settings={"xc_search": {"token": "a" * 32}},
        kind="search",
    )

    async def fake_get_page(_client, _url):
        return page

    monkeypatch.setattr(gateway, "_get_page", fake_get_page)
    result = await gateway.search(query="契約不足")
    assert result.status == "unavailable"
    assert result.reason_code == "opac_token_missing"


@pytest.mark.asyncio
async def test_detail_read_uses_context_ref_and_rejects_unknown_ref(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OPAC_TRANSPORT", "server")
    gateway = OpacGateway()
    record = LibraryBibliographicRecord(
        resource_ref="orbit-library://record/8935255aff1c5a9e",
        title="大規模言語モデル入門",
        authors=["山田育矢"],
        url="https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/BD03194521",
        holdings=[
            LibraryHoldingSummary(
                campus="toyosu",
                location="豊洲図書館",
                status="unavailable",
            )
        ],
    )
    context = ChatLibraryContextRecord(
        resource_ref=record.resource_ref,
        record=record,
        evidence_ids=["library-catalog-search-v1-abcdefghijklmnopqrstuvwxyz"],
        observed_at="2026-08-24T00:00:00Z",
    )
    unavailable = await gateway.read(
        resource_ref="orbit-library://record/0123456789abcdef",
        records=[context],
    )
    assert unavailable.status == "unavailable"
    assert unavailable.reason_code == "resource_ref_mismatch"


@pytest.mark.asyncio
async def test_gateway_rejects_external_redirect_before_following(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OPAC_TRANSPORT", "server")
    gateway = OpacGateway()
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(
            302,
            headers={"location": "https://example.invalid/leak"},
            request=request,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(OpacGatewayError) as error:
            await gateway._get_same_origin(
                client,
                "https://library.shibaura-it.ac.jp/opc/xc/search/public",
            )
    assert error.value.reason_code == "opac_redirect_rejected"
    assert calls == ["https://library.shibaura-it.ac.jp/opc/xc/search/public"]


@pytest.mark.asyncio
async def test_gateway_follows_same_origin_redirect_without_replaying_query(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OPAC_TRANSPORT", "server")
    gateway = OpacGateway()
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if len(calls) == 1:
            return httpx.Response(
                302,
                headers={
                    "location": "/opc/recordID/catalog.bib/BD03194521?caller=xc-search",
                },
                request=request,
            )
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            content=b"<html></html>",
            request=request,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        response = await gateway._get_same_origin(
            client,
            "https://library.shibaura-it.ac.jp/opc/xc/search/public?os%5Bkeys%5D=public",
        )
    assert response.status_code == 200
    assert calls == [
        "https://library.shibaura-it.ac.jp/opc/xc/search/public?os%5Bkeys%5D=public",
        "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/BD03194521?caller=xc-search",
    ]


def test_gateway_rejects_untrusted_ncip_path() -> None:
    with pytest.raises(OpacGatewayError) as error:
        # The helper is intentionally exercised through the public error type;
        # a path outside the fixed same-origin allowlist must fail closed.
        from orbit_api.library.opac_gateway import _safe_url

        _safe_url(
            "https://library.shibaura-it.ac.jp/opc/admin/secret",
            (NCIP_MULTI_PATH,),
        )
    assert error.value.reason_code == "opac_redirect_rejected"
