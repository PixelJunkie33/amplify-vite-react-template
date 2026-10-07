import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { Amplify } from "aws-amplify";
import outputs from "../amplify_outputs.json";

// The Amplify backend stays configured exactly as it was. The arena UI does
// not read from it, but leaving this in place keeps the hosted build and the
// deployed backend wired together as before.
Amplify.configure(outputs);

// Note: the template's src/index.css is deliberately NOT imported. It styles
// the old Todo page — a purple gradient, `width: 100vw`, flex centering — and
// it fought the arena's own stylesheet, overflowing every page sideways. The
// arena's styles live in shared/theme.css, which App.tsx imports and the
// server serves at /arena.css, so both halves of the site look the same.

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
