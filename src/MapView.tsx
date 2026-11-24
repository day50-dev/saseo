// A map on an object card: OpenStreetMap tiles, the places the geocoder found (labeled, colored by
// group, joined in order for a route), and outlined areas. Loaded on demand: OpenLayers is large.
// Wheel scrolling stays with the canvas; drag pans the map, the buttons zoom.
import { useEffect, useRef, useState } from "react";
import OlMap from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import LineString from "ol/geom/LineString";
import MultiPolygon from "ol/geom/MultiPolygon";
import Polygon from "ol/geom/Polygon";
import GeoJSON from "ol/format/GeoJSON";
import { fromLonLat } from "ol/proj";
import { defaults as defaultInteractions } from "ol/interaction/defaults";
import { Circle, Fill, Stroke, Style, Text } from "ol/style";
import { createEmpty, extend, isEmpty } from "ol/extent";
import "ol/ol.css";
import type { PlaceMap } from "../shared/canvas.ts";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#2f6fbf";
const hexA = (c: string, a: number) => {
  const m = c.match(/^#([0-9a-f]{6})$/i);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

export default function MapView({ map }: { map: PlaceMap }) {
  const el = useRef<HTMLDivElement>(null);
  const olRef = useRef<OlMap | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const groups = [...new Set([...map.places.map((p) => p.group), ...(map.areas ?? []).map((a) => a.group)].filter(Boolean))] as string[];
  const colorOf = (g?: string) => css(`--fig-${((g ? groups.indexOf(g) : 0) % 6) + 1}`);

  useEffect(() => {
    if (!el.current) return;
    const text = css("--text");
    const halo = css("--card");
    const source = new VectorSource();
    const placeAt: Point[] = [];
    const mainPieces: Polygon[] = [];
    const geo = new GeoJSON();
    for (const a of map.areas ?? []) {
      try {
        const geometry = geo.readGeometry(a.geometry, { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" });
        const f = new Feature({ geometry: geometry ?? undefined });
        const c = colorOf(a.group);
        f.setStyle(
          new Style({
            fill: new Fill({ color: hexA(c, 0.14) }),
            stroke: new Stroke({ color: c, width: 1.6 }),
          }),
        );
        source.addFeature(f);
        // One label, on its largest piece (France, not every overseas island).
        const main =
          geometry instanceof MultiPolygon ? geometry.getPolygons().sort((x, y) => y.getArea() - x.getArea())[0] : geometry instanceof Polygon ? geometry : null;
        if (main) {
          mainPieces.push(main);
          const label = new Feature({ geometry: main.getInteriorPoint() });
          label.setStyle(new Style({ text: new Text({ text: a.name, font: "italic 12px sans-serif", fill: new Fill({ color: c }), stroke: new Stroke({ color: halo, width: 3 }) }) }));
          source.addFeature(label);
        }
      } catch {
        // An outline that won't read is left off.
      }
    }
    if (map.route && map.places.length > 1) {
      const line = new Feature({ geometry: new LineString(map.places.map((p) => fromLonLat([p.lon, p.lat]))) });
      line.setStyle(new Style({ stroke: new Stroke({ color: css("--muted"), width: 2.5, lineDash: [6, 5] }) }));
      source.addFeature(line);
    }
    map.places.forEach((p, i) => {
      const at = new Point(fromLonLat([p.lon, p.lat]));
      placeAt.push(at);
      const f = new Feature({ geometry: at });
      const c = colorOf(p.group);
      f.setStyle(
        new Style({
          image: new Circle({ radius: 6, fill: new Fill({ color: c }), stroke: new Stroke({ color: halo, width: 2 }), ...(p.approximate ? { stroke: new Stroke({ color: css("--fail"), width: 2, lineDash: [2, 2] }) } : {}) }),
          text: new Text({
            text: `${map.route ? `${i + 1}. ` : ""}${p.name}${p.approximate ? "?" : ""}`,
            font: "12px sans-serif",
            offsetY: -14,
            fill: new Fill({ color: text }),
            stroke: new Stroke({ color: halo, width: 3 }),
          }),
          zIndex: 10,
        }),
      );
      source.addFeature(f);
    });
    const ol = new OlMap({
      target: el.current,
      layers: [new TileLayer({ source: new OSM(), className: "map-tiles" }), new VectorLayer({ source, declutter: true })],
      view: new View({ center: fromLonLat([0, 20]), zoom: 2 }),
      // The wheel belongs to the canvas; zoom with the buttons, a double click, or a pinch.
      interactions: defaultInteractions({ mouseWheelZoom: false }),
    });
    // Fit the places; outlines are context (France's overseas islands mustn't zoom out to the world).
    // With no places, fit the outlines' main pieces.
    const ext = createEmpty();
    for (const g of map.places.length ? placeAt : mainPieces) extend(ext, g.getExtent());
    if (!isEmpty(ext)) ol.getView().fit(ext, { padding: [50, 60, 40, 60], maxZoom: 9 });
    olRef.current = ol;
    return () => {
      ol.setTarget(undefined);
      olRef.current = null;
    };
    // The map is drawn once per object; a redo makes a new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  const go = (i: number) => {
    const p = map.places[i];
    setPicked(i);
    olRef.current?.getView().animate({ center: fromLonLat([p.lon, p.lat]), zoom: Math.max(olRef.current.getView().getZoom() ?? 6, 7), duration: 400 });
  };

  return (
    <div className="figure figure-map" onPointerDown={(e) => e.stopPropagation()}>
      <div ref={el} className="map-box" />
      {groups.length > 1 && (
        <div className="figure-legend small">
          {groups.map((g) => (
            <span key={g}>
              <i style={{ background: colorOf(g) }} />
              {g}
            </span>
          ))}
        </div>
      )}
      {map.caption && <p className="small figure-caption">{map.caption}</p>}
      <ol className={`map-places small${map.route ? "" : " unordered"}`}>
        {map.places.map((p, i) => (
          <li key={i} className={picked === i ? "on" : ""}>
            <button type="button" className="link" onClick={() => go(i)} title="Show it on the map">
              {p.name}
            </button>
            {p.approximate && <span className="map-approx" title="The geocoder couldn't find it; placed where the model thought it is"> roughly placed</span>}
            {p.note && <span className="muted">: {p.note}</span>}
          </li>
        ))}
      </ol>
      {map.missing?.length ? <p className="small muted">Couldn't find: {map.missing.join(", ")}.</p> : null}
      {map.areas?.length ? <p className="small muted">Outlines are today's borders.</p> : null}
    </div>
  );
}
