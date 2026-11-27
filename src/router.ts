// A tiny path router: canvases live at /c/<id>, which is stable and bookmarkable.
import { useEffect, useState } from "react";

export type Route = { page: "home" } | { page: "canvas"; id: string } | { page: "settings" } | { page: "zotero" } | { page: "signin" } | { page: "join"; token: string } | { page: "missing" };

export function parse(path: string): Route {
  if (path === "/" || path === "") return { page: "home" };
  if (path === "/settings") return { page: "settings" };
  if (path === "/zotero") return { page: "zotero" };
  if (path === "/signin" || path === "/signup") return { page: "signin" };
  const j = path.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
  if (j) return { page: "join", token: j[1] };
  const m = path.match(/^\/c\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { page: "canvas", id: m[1] };
  return { page: "missing" };
}

/** Whether this tab has moved between pages of the app, so "back" stays inside it. */
export let movedInApp = false;

/** Back to the previous page of the app, or to the canvases if this page was opened directly. */
export function goBack() {
  if (movedInApp) history.back();
  else navigate("/");
}

export function navigate(path: string) {
  if (location.pathname === path) return;
  movedInApp = true;
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  // The old #settings link still works.
  if (location.hash === "#settings") history.replaceState(null, "", "/settings");
  const [route, setRoute] = useState(() => parse(location.pathname));
  useEffect(() => {
    const on = () => setRoute(parse(location.pathname));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return route;
}

/** For <a href> inside the app: plain clicks navigate in place, modified clicks open normally. */
export function linkTo(path: string) {
  return {
    href: path,
    onClick: (e: React.MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(path);
    },
  };
}
