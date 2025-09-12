import React from "react";
import { createRoot } from "react-dom/client";

// If your app's entry component has a different filename, update this import:
import App from "./App.jsx";

// If you don't have an index.css yet, keep this import (and create the file below).
import "./index.css";

const root = document.getElementById("root");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
