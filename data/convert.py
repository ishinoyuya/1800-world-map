"""
1800年の世界地図(aourednik/historical-basemaps由来のGeoJSON)を読み込み、
経緯度(lon/lat)を正距円筒図法でx,yに投影して、ゲーム用データ(../js/data.js)に変換する。

1900年版との大きな違い: このデータセットにはオーストラリア先住民の細分領域や
北米・南米・アフリカ南部の先住民族の領域など、国家と呼べない領域が
546件中450件近く含まれる(1900年版にはほぼ存在しなかった)。
そのため1900年版の「除外リスト方式」ではなく、
実在した国家・帝国・植民地・副王領だけを明示的に選ぶ「採用リスト方式」にする。

- 同名の複数featureは1つの国(MultiPolygon)にまとめる
- 日付変更線問題は「最大の一塊(陸地)」のbboxを当たり判定・ラベル位置の基準にする
- 採用しなかった領域は操作不可の背景land(neutral)として残す
- 全ランド(採用+非採用)をshapelyでunionし、外周(海岸線)だけを抽出してoutlineとする
"""
import json
import math
import os
from collections import defaultdict

from shapely.geometry import shape
from shapely.ops import unary_union

BASE = os.path.dirname(__file__)

# 実在した国家・帝国・植民地・副王領のみを採用(546件中90件)。
# オーストラリア先住民の細分領域(約350件)、北米・南米・アフリカの
# 先住民族の領域、"central Asian khanates"のような曖昧な集合地域などは
# ここに含めず、操作不可の背景として表示する。
INCLUDE_NAMES = {
    "Russian Empire", "Qing Empire", "Rupert's Land", "Denmark-Norway",
    "Vice-Royalty of Brazil", "Vice-Royalty of New Spain", "Luisiana",
    "Ottoman Empire", "Vice-Royalty of New Granada", "United States of America",
    "Vice-Royalty of Peru", "Viceroyalty of the Río de la Plata", "Persia",
    "Dutch East Indies", "Sweden", "Afghanistan", "Quebec",
    "Maratha Confederacy", "Austrian Empire", "Rattanakosin Kingdom", "Spain",
    "France", "Nejd", "Burma", "Sikhs", "Morocco", "Prussia", "Algiers",
    "Japan", "Madagascar", "Segu", "Papua New Guinea", "Bornu-Kanem",
    "United Kingdom", "Paraguay", "Darfur", "Funj", "Hausa States", "Luba",
    "Malaya", "Đại Việt", "Ethiopia", "Korea", "Lunda", "Nepal", "Philippines",
    "Zanzibar", "British Guiana", "Nizam's Dominions", "Cambodia", "Bagirmi",
    "Asante", "Sindh", "Kingdom of Ireland", "Mysore", "Portugal",
    "Kingdom of the Two Sicilies", "Tunis", "Wadai", "Cape Colony",
    "Kingdom of Sardinia", "Oman", "Dahomey", "Tripolitania", "Congo", "Yemen",
    "Cyrenaica", "Portuguese East Africa", "Saxony", "Papal States",
    "Batavian Republic", "Oudh", "Helvetic Republic", "Bhutan", "Bavaria",
    "Ceylon (Dutch)", "Cochin China", "Tuscany", "Tuʻi Tonga Empire", "Baden",
    "Württemberg", "Senegal", "Travancore", "Brunei", "Portuguese Guinea",
    "Luxembourg", "Hanover", "Laos", "Acadian Peninsula (UK)", "Kandy",
}

NAME_JA = {
    "Russian Empire": "ロシア帝国", "Qing Empire": "清", "Rupert's Land": "ルパーツランド",
    "Denmark-Norway": "デンマーク＝ノルウェー", "Vice-Royalty of Brazil": "ブラジル副王領",
    "Vice-Royalty of New Spain": "ヌエバ・エスパーニャ副王領", "Luisiana": "ルイジアナ",
    "Ottoman Empire": "オスマン帝国", "Vice-Royalty of New Granada": "ヌエバ・グラナダ副王領",
    "United States of America": "アメリカ合衆国", "Vice-Royalty of Peru": "ペルー副王領",
    "Viceroyalty of the Río de la Plata": "リオ・デ・ラ・プラタ副王領", "Persia": "ペルシア",
    "Dutch East Indies": "蘭領東インド", "Sweden": "スウェーデン",
    "Afghanistan": "アフガニスタン(ドゥッラーニー朝)", "Quebec": "ケベック(英)",
    "Maratha Confederacy": "マラーター同盟", "Austrian Empire": "オーストリア帝国",
    "Rattanakosin Kingdom": "シャム(ラタナコーシン王国)", "Spain": "スペイン", "France": "フランス",
    "Nejd": "ネジド(サウード王国)", "Burma": "ビルマ(コンバウン朝)", "Sikhs": "シク王国",
    "Morocco": "モロッコ", "Prussia": "プロイセン", "Algiers": "アルジェ(バルバリア)",
    "Japan": "日本(江戸幕府)", "Madagascar": "マダガスカル", "Segu": "セグー王国",
    "Papua New Guinea": "パプアニューギニア", "Bornu-Kanem": "ボルヌ帝国",
    "United Kingdom": "グレートブリテン王国", "Paraguay": "パラグアイ",
    "Darfur": "ダルフール・スルタン国", "Funj": "フンジ・スルタン国",
    "Hausa States": "ハウサ諸王国", "Luba": "ルバ王国", "Malaya": "マラヤ",
    "Đại Việt": "大越(ベトナム)", "Ethiopia": "エチオピア", "Korea": "朝鮮", "Lunda": "ルンダ王国",
    "Nepal": "ネパール", "Philippines": "フィリピン", "Zanzibar": "ザンジバル",
    "British Guiana": "英領ギアナ", "Nizam's Dominions": "ハイデラバード(ニザーム王国)",
    "Cambodia": "カンボジア", "Bagirmi": "バギルミ王国", "Asante": "アシャンティ王国",
    "Sindh": "シンド(タルプル朝)", "Kingdom of Ireland": "アイルランド王国",
    "Mysore": "マイソール王国", "Portugal": "ポルトガル",
    "Kingdom of the Two Sicilies": "両シチリア王国", "Tunis": "チュニス(バルバリア)",
    "Wadai": "ワダイ王国", "Cape Colony": "ケープ植民地",
    "Kingdom of Sardinia": "サルデーニャ王国", "Oman": "オマーン", "Dahomey": "ダホメ王国",
    "Tripolitania": "トリポリタニア(バルバリア)", "Congo": "コンゴ王国", "Yemen": "イエメン",
    "Cyrenaica": "キレナイカ", "Portuguese East Africa": "ポルトガル領東アフリカ",
    "Saxony": "ザクセン", "Papal States": "教皇領",
    "Batavian Republic": "バタヴィア共和国(オランダ)", "Oudh": "アワド王国",
    "Helvetic Republic": "ヘルヴェティア共和国(スイス)", "Bhutan": "ブータン",
    "Bavaria": "バイエルン", "Ceylon (Dutch)": "セイロン(蘭)", "Cochin China": "コーチシナ",
    "Tuscany": "トスカーナ", "Tuʻi Tonga Empire": "トゥイ・トンガ帝国", "Baden": "バーデン",
    "Württemberg": "ヴュルテンベルク", "Senegal": "セネガル",
    "Travancore": "トラヴァンコール王国", "Brunei": "ブルネイ",
    "Portuguese Guinea": "ポルトガル領ギニア", "Luxembourg": "ルクセンブルク",
    "Hanover": "ハノーファー", "Laos": "ラオス",
    "Acadian Peninsula (UK)": "アカディア半島(英)", "Kandy": "キャンディ王国",
}

# 地域モード用の区分。ロシア帝国とオスマン帝国はヨーロッパ/西アジア(オスマンはこちらのみ)
# ロシア帝国のみヨーロッパと東アジア・東南アジアの両方に属する(1900年版と同じ扱い)。
REGIONS = {
    "europe": [
        "Denmark-Norway", "Sweden", "Austrian Empire", "Spain", "France",
        "Prussia", "United Kingdom", "Portugal", "Kingdom of the Two Sicilies",
        "Kingdom of Sardinia", "Papal States", "Batavian Republic",
        "Helvetic Republic", "Bavaria", "Saxony", "Baden", "Württemberg",
        "Hanover", "Kingdom of Ireland", "Tuscany", "Luxembourg",
        "Russian Empire",
    ],
    "africa": [
        "Morocco", "Algiers", "Tunis", "Tripolitania", "Cyrenaica",
        "Madagascar", "Segu", "Bornu-Kanem", "Darfur", "Funj", "Hausa States",
        "Luba", "Lunda", "Ethiopia", "Zanzibar", "Bagirmi", "Asante", "Wadai",
        "Cape Colony", "Dahomey", "Congo", "Portuguese East Africa", "Senegal",
        "Portuguese Guinea",
    ],
    "americas": [
        "Vice-Royalty of Brazil", "Vice-Royalty of New Spain", "Luisiana",
        "Vice-Royalty of New Granada", "United States of America",
        "Vice-Royalty of Peru", "Viceroyalty of the Río de la Plata", "Quebec",
        "Rupert's Land", "Paraguay", "British Guiana",
        "Acadian Peninsula (UK)",
    ],
    "wsasia": [
        "Ottoman Empire", "Persia", "Afghanistan", "Nejd", "Yemen", "Oman",
        "Maratha Confederacy", "Sikhs", "Nizam's Dominions", "Mysore", "Sindh",
        "Oudh", "Travancore", "Kandy", "Bhutan", "Nepal", "Ceylon (Dutch)",
    ],
    "easia": [
        "Qing Empire", "Japan", "Korea", "Rattanakosin Kingdom",
        "Cochin China", "Đại Việt", "Cambodia", "Laos", "Burma", "Malaya",
        "Dutch East Indies", "Philippines", "Brunei", "Russian Empire",
    ],
    "oceania": [
        "Papua New Guinea", "Tuʻi Tonga Empire",
    ],
}
COUNTRY_REGIONS = {}
for region, names in REGIONS.items():
    for n in names:
        COUNTRY_REGIONS.setdefault(n, []).append(region)

# 地図上のラベル用の短縮表記(長すぎてピース内に収まらない名前だけ上書き)
LABEL_JA_SHORT = {
    "Vice-Royalty of Brazil": "ブラジル", "Vice-Royalty of New Spain": "ヌエバスペイン",
    "Vice-Royalty of New Granada": "ヌエバグラナダ", "Vice-Royalty of Peru": "ペルー",
    "Viceroyalty of the Río de la Plata": "リオデラプラタ",
    "Afghanistan": "アフガニスタン", "Rattanakosin Kingdom": "シャム", "Nejd": "ネジド",
    "Burma": "ビルマ", "United Kingdom": "イギリス", "Darfur": "ダルフール",
    "Funj": "フンジ", "Hausa States": "ハウサ諸国", "Nizam's Dominions": "ハイデラバード",
    "Sindh": "シンド", "Kingdom of the Two Sicilies": "両シチリア", "Tunis": "チュニス",
    "Tripolitania": "トリポリタニア", "Batavian Republic": "バタヴィア共和国",
    "Oudh": "アワド", "Helvetic Republic": "スイス", "Ceylon (Dutch)": "セイロン",
    "Tuʻi Tonga Empire": "トンガ帝国", "Travancore": "トラヴァンコール",
    "Acadian Peninsula (UK)": "アカディア(英)", "Denmark-Norway": "デンマーク",
    "Maratha Confederacy": "マラーター", "Portuguese East Africa": "ポルトガル領東ア",
}


def project(lon, lat):
    return (lon, -lat)


def ring_area_and_bbox(ring):
    area = 0.0
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        area += x1 * y2 - x2 * y1
        minx = min(minx, x1); maxx = max(maxx, x1)
        miny = min(miny, y1); maxy = max(maxy, y1)
    return abs(area) / 2.0, (minx, miny, maxx, maxy)


def largest_part(proj_polygons):
    """複数島/飛び地からなる国の中で最大の陸塊(外周ring)の面積とbboxを返す"""
    best_area, best_bbox = -1.0, None
    for poly in proj_polygons:
        outer = poly[0]
        area, bbox = ring_area_and_bbox(outer)
        if area > best_area:
            best_area, best_bbox = area, bbox
    return best_area, best_bbox


def total_area(proj_polygons):
    total = 0.0
    for poly in proj_polygons:
        outer_area, _ = ring_area_and_bbox(poly[0])
        hole_area = sum(ring_area_and_bbox(r)[0] for r in poly[1:])
        total += outer_area - hole_area
    return total


def point_in_polygons(pt, proj_polygons):
    x, y = pt
    for poly in proj_polygons:
        crossings = 0
        for ring in poly:
            n = len(ring)
            for i in range(n):
                x1, y1 = ring[i]
                x2, y2 = ring[(i + 1) % n]
                if (y1 > y) != (y2 > y):
                    xin = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                    if x < xin:
                        crossings += 1
        if crossings % 2 == 1:
            return True
    return False


def dist_point_segment(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(px - x1, py - y1)
    t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    cx, cy = x1 + t * dx, y1 + t * dy
    return math.hypot(px - cx, py - cy)


def min_dist_to_boundary(pt, proj_polygons):
    x, y = pt
    best = float("inf")
    for poly in proj_polygons:
        for ring in poly:
            n = len(ring)
            for i in range(n):
                x1, y1 = ring[i]
                x2, y2 = ring[(i + 1) % n]
                d = dist_point_segment(x, y, x1, y1, x2, y2)
                if d < best:
                    best = d
    return best


def visual_center(proj_polygons, search_bbox):
    """search_bbox(=最大陸塊のbbox)の範囲内だけをグリッド探索して、
    ポリゴン内部で最も縁から遠い点を求める(飛び地・日付変更線越えでも暴走しない)"""
    minx, miny, maxx, maxy = search_bbox
    best_pt = [(minx + maxx) / 2, (miny + maxy) / 2]
    best_score = -1.0

    def search(cx0, cy0, cx1, cy1, steps):
        nonlocal best_pt, best_score
        for i in range(steps + 1):
            for j in range(steps + 1):
                x = cx0 + (cx1 - cx0) * i / steps
                y = cy0 + (cy1 - cy0) * j / steps
                if point_in_polygons((x, y), proj_polygons):
                    d = min_dist_to_boundary((x, y), proj_polygons)
                    if d > best_score:
                        best_score = d
                        best_pt = [x, y]

    search(minx, miny, maxx, maxy, 20)
    span_x, span_y = (maxx - minx), (maxy - miny)
    for factor in (0.22, 0.07):
        wx, wy = max(span_x * factor, 1e-6), max(span_y * factor, 1e-6)
        bx, by = best_pt
        search(bx - wx, by - wy, bx + wx, by + wy, 12)

    return best_pt


def multipolygon_to_proj_polygons(coords):
    """GeoJSON MultiPolygonのcoordinatesを投影済み[[ring,...],...]に変換"""
    polygons = []
    for poly in coords:
        rings = [[project(lon, lat) for lon, lat in ring] for ring in poly]
        polygons.append(rings)
    return polygons


def boundary_to_polylines(geom, min_area=0.0):
    """shapelyのunion結果(Polygon/MultiPolygon)のboundaryを、
    キャンバス描画用の点列リストに変換する(内部境界=国境は含まれない)。
    min_area未満の小片(bufferで埋めきれなかった隙間の残骸など)は除外する。"""
    lines = []

    def add_ring(coords):
        lines.append([list(project(lon, lat)) for lon, lat in coords])

    polys = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
    for poly in polys:
        if poly.area < min_area:
            continue
        add_ring(list(poly.exterior.coords))
        for interior in poly.interiors:
            add_ring(list(interior.coords))
    return lines


def main():
    src = json.load(open(os.path.join(BASE, "world_1800.geojson"), encoding="utf-8"))
    feats = src["features"]

    named = defaultdict(list)  # name -> list of raw MultiPolygon coordinate lists
    named_props = {}
    all_shapes = []

    for f in feats:
        name = f["properties"].get("NAME")
        coords = f["geometry"]["coordinates"]  # 全featureがMultiPolygon
        if name:
            named[name].append(coords)
            named_props[name] = f["properties"]
        all_shapes.append(shape(f["geometry"]))

    missing_ja = []
    countries_out = []
    excluded_polygons = []  # 採用しなかった領域も陸地としては背景に残す
    for name, coord_groups in named.items():
        merged_coords = [poly for group in coord_groups for poly in group]
        proj_polygons = multipolygon_to_proj_polygons(merged_coords)

        if name not in INCLUDE_NAMES:
            excluded_polygons.append(proj_polygons)
            continue

        if name not in NAME_JA:
            missing_ja.append(name)

        area = total_area(proj_polygons)
        _, main_bbox = largest_part(proj_polygons)
        minx, miny, maxx, maxy = main_bbox
        centroid = [(minx + maxx) / 2, (miny + maxy) / 2]
        label_pt = visual_center(proj_polygons, main_bbox)

        props = named_props[name]
        countries_out.append({
            "id": name,
            "name": name,
            "nameJa": NAME_JA.get(name, name),
            "labelJa": LABEL_JA_SHORT.get(name, NAME_JA.get(name, name)),
            "regions": COUNTRY_REGIONS.get(name, []),
            "abbrev": props.get("ABBREVN") or name,
            "polygons": proj_polygons,
            "bbox": [minx, miny, maxx, maxy],
            "centroid": centroid,
            "labelPoint": label_pt,
            "area": area,
        })

    countries_out.sort(key=lambda c: -c["area"])

    # NAMEなしのfeatureは元々存在しない(このデータセットは全featureにNAMEがある)。
    # 不採用の国はすべて excluded_polygons に入っている。
    neutral_out = excluded_polygons

    # 全ランドをunionして海岸線(=国境を含まない外周)を抽出。
    # このデータセットは隣接国同士の境界が厳密に一致していない(小さな隙間がある)ため、
    # 素直にunionすると隙間の分だけ大量の細切れポリゴン(ノイズ線)が残ってしまう。
    # 一度太らせてからunionし、同じ分だけ痩せさせる("buffer-unbuffer")ことで
    # 小さな隙間を埋めてから外周を抽出する。
    buf = 0.2
    grown = [s.buffer(buf, join_style=2) for s in all_shapes]
    world_union = unary_union(grown).buffer(-buf, join_style=2)
    outline = boundary_to_polylines(world_union, min_area=0.3)

    data = {
        "countries": countries_out,
        "neutralLand": neutral_out,
        "outline": outline,
    }

    out_dir = os.path.join(BASE, "..", "js")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "data.js")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("// 自動生成ファイル (convert.py で生成) 手動編集しないこと\n")
        f.write("const GAME_DATA = ")
        json.dump(data, f, ensure_ascii=False)
        f.write(";\n")

    print(f"countries: {len(countries_out)}")
    print(f"excluded (kept as background): {len(excluded_polygons)}")
    print(f"neutral land pieces: {len(neutral_out)}")
    print(f"outline polylines: {len(outline)}")
    print(f"wrote {out_path}")
    if missing_ja:
        print(f"WARNING: missing NAME_JA for {len(missing_ja)}: {missing_ja}")
    missing_region = [c["name"] for c in countries_out if not c["regions"]]
    if missing_region:
        print(f"WARNING: missing region assignment for {len(missing_region)}: {missing_region}")
    unknown_include = INCLUDE_NAMES - set(named.keys())
    if unknown_include:
        print(f"WARNING: INCLUDE_NAMES not found in source data: {sorted(unknown_include)}")


if __name__ == "__main__":
    main()
