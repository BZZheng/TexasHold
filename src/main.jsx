import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/epilogue/400.css";
import "@fontsource/epilogue/500.css";
import "@fontsource/epilogue/600.css";
import "@fontsource/epilogue/700.css";
import "./styles.css";
import "./hextech/hextech.css";
import App from "./App.jsx";
import { installClientDiagnostics } from "./telemetry.js";

installClientDiagnostics();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
