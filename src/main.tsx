import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import MpvOverlay from "./pages/MpvOverlay";
import MpvSubSearch from "./pages/MpvSubSearch";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

// The mpv helper windows load this same bundle with an ?overlay= flag and render
// just their piece (the video overlay / the subtitle-search dialog), not the app.
const overlay = new URLSearchParams(window.location.search).get("overlay");
if (overlay === "mpvoverlay") {
  // Transparent window over the video: its document must not paint the app's
  // opaque background, or it would hide the video.
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  root.render(
    <React.StrictMode>
      <MpvOverlay />
    </React.StrictMode>
  );
} else if (overlay === "subsearch") {
  root.render(
    <React.StrictMode>
      <MpvSubSearch />
    </React.StrictMode>
  );
} else {
  root.render(
    <React.StrictMode>
      <HashRouter>
        <ErrorBoundary hard>
          <App />
        </ErrorBoundary>
      </HashRouter>
    </React.StrictMode>
  );
}
