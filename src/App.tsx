import { useEffect, useState } from "react";
import { Canvas } from "./Canvas.tsx";
import { Settings } from "./Settings.tsx";

export function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash === "#settings" ? <Settings /> : <Canvas />;
}
