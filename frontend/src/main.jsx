import React from "react";
import ReactDOM from "react-dom/client";

// Inter, served from our own origin rather than fonts.googleapis.com.
//
// Google Fonts is blocked in mainland China, and this app is for a collection
// of Chinese tea — the visitors most likely to want it are the ones who cannot
// reach that host. A blocked stylesheet does not fail fast either: the request
// hangs on a poisoned DNS answer until the connect times out, and the browser
// treats a pending @import as render-blocking, so the whole app waited on it.
//
// Latin subsets only, at the four weights the UI actually asks for: 96 KB of
// woff2 in total, cached with the rest of the build. Chinese glyphs are NOT a
// webfont at all — see HANZI in App.jsx.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";

import App from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
