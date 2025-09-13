import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { io } from "socket.io-client";

function App() {
  const [status, setStatus] = useState("connecting…");
  const [snapshot, setSnapshot] = useState(null);

  useEffect(() => {
    const s = io({ path: "/socket.io" }); // same-origin
    s.on("connect", () => setStatus("connected"));
    s.on("disconnect", () => setStatus("disconnected"));
    s.on("connect_error", (err) => setStatus("connect_error: " + err.message));
    s.on("snapshot", (snap) => setSnapshot(snap));
    return () => s.close();
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, Arial", padding: 16 }}>
      <h1 style={{ margin: 0 }}>Kraken Volume (debug)</h1>
      <p style={{ marginTop: 8 }}>Socket: <strong>{status}</strong></p>
      {snapshot ? (
        <pre style={{
          background: "#f5f5f5",
          padding: 12,
          borderRadius: 8,
          maxHeight: "60vh",
          overflow: "auto",
          marginTop: 12
        }}>
{JSON.stringify(snapshot, null, 2)}
        </pre>
      ) : (
        <p>Waiting for snapshot…</p>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
